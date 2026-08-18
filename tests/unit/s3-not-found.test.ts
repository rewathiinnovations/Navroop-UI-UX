import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { isObjectNotFoundError } from '@/lib/storage/s3-errors';

/**
 * How the installed AWS SDK actually signals "that object is not there".
 *
 * `lib/storage/index.ts` may only answer `null` / `false` for a genuinely absent object;
 * everything else has to throw. Getting that right needs the SDK's real error shapes, and
 * they are not guessable: a HEAD response carries no body, so S3 cannot name the error and
 * the SDK falls back to the status code, while `NoSuchBucket` answers 404 as well without
 * being about the key at all.
 *
 * So this does not assert against remembered documentation. It drives a real `S3Client`
 * with a stub transport that replays canned HTTP responses, lets the SDK's own
 * deserializer build the error, and checks both the error identity and the verdict
 * `isObjectNotFoundError` reaches. No socket is opened — the request handler never calls
 * out — so this cannot reach ElasticLake or S3.
 *
 * Goes red if: the predicate starts swallowing failures again (every `absent: false` row);
 * it stops recognising an absent key (`absent: true` rows); or a future SDK upgrade
 * changes which exception it raises for a 404, in which case the `name` / `status`
 * expectations fail and point at the classifier that now needs updating.
 */

type CannedResponse = {
  statusCode: number;
  headers: Record<string, string>;
  /** Undefined means an empty body, which is all a HEAD ever has. */
  body?: string;
};

function replay(canned: CannedResponse) {
  return {
    handle: async () => ({
      response: {
        statusCode: canned.statusCode,
        reason: '',
        headers: canned.headers,
        body: Readable.from(canned.body === undefined ? [] : [Buffer.from(canned.body)]),
      },
    }),
    updateHttpClientConfig: () => undefined,
    httpHandlerConfigs: () => ({}),
    destroy: () => undefined,
  };
}

function refuseConnection() {
  return {
    handle: async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.4:9000'), {
        code: 'ECONNREFUSED',
      });
    },
    updateHttpClientConfig: () => undefined,
    httpHandlerConfigs: () => ({}),
    destroy: () => undefined,
  };
}

function clientWith(transport: ReturnType<typeof replay> | ReturnType<typeof refuseConnection>) {
  return new S3Client({
    region: 'auto',
    endpoint: 'http://elk.invalid',
    credentials: { accessKeyId: 'test-only', secretAccessKey: 'test-only' },
    forcePathStyle: true,
    maxAttempts: 1,
    requestHandler: transport,
  });
}

function xmlError(code: string, message: string) {
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;
}

const XML = { 'content-type': 'application/xml' };

type Verb = 'get' | 'head';

type Case = {
  label: string;
  verb: Verb;
  canned: CannedResponse | 'refused';
  /** What the SDK is expected to name the error. */
  name: string;
  status: number | null;
  /** Whether storage may report this as an absent object. */
  absent: boolean;
};

const CASES: Case[] = [
  {
    label: 'GET on a key that is not in the bucket',
    verb: 'get',
    canned: { statusCode: 404, headers: XML, body: xmlError('NoSuchKey', 'The specified key does not exist.') },
    name: 'NoSuchKey',
    status: 404,
    absent: true,
  },
  {
    label: 'GET 404 from an S3-compatible service that sends no error body',
    verb: 'get',
    canned: { statusCode: 404, headers: {} },
    name: 'NotFound',
    status: 404,
    absent: true,
  },
  {
    label: 'HEAD on a key that is not in the bucket',
    verb: 'head',
    canned: { statusCode: 404, headers: {} },
    name: 'NotFound',
    status: 404,
    absent: true,
  },
  {
    label: 'GET against a bucket that does not exist',
    verb: 'get',
    canned: {
      statusCode: 404,
      headers: XML,
      body: xmlError('NoSuchBucket', 'The specified bucket does not exist.'),
    },
    name: 'NoSuchBucket',
    status: 404,
    absent: false,
  },
  {
    label: 'GET with rejected credentials',
    verb: 'get',
    canned: { statusCode: 403, headers: XML, body: xmlError('AccessDenied', 'Access Denied') },
    name: 'AccessDenied',
    status: 403,
    absent: false,
  },
  {
    label: 'GET while throttled',
    verb: 'get',
    canned: {
      statusCode: 503,
      headers: XML,
      body: xmlError('SlowDown', 'Please reduce your request rate.'),
    },
    name: 'SlowDown',
    status: 503,
    absent: false,
  },
  {
    label: 'GET when the service is broken',
    verb: 'get',
    canned: { statusCode: 500, headers: {} },
    name: 'Unknown',
    status: 500,
    absent: false,
  },
  {
    label: 'HEAD with rejected credentials',
    verb: 'head',
    canned: { statusCode: 403, headers: {} },
    name: 'Unknown',
    status: 403,
    absent: false,
  },
  {
    label: 'HEAD when the service is broken',
    verb: 'head',
    canned: { statusCode: 500, headers: {} },
    name: 'Unknown',
    status: 500,
    absent: false,
  },
  {
    label: 'HEAD rejected as a bad request',
    verb: 'head',
    canned: { statusCode: 400, headers: {} },
    name: 'Unknown',
    status: 400,
    absent: false,
  },
  {
    label: 'GET when ElasticLake is unreachable',
    verb: 'get',
    canned: 'refused',
    name: 'Error',
    status: null,
    absent: false,
  },
];

async function raise(testCase: Case): Promise<unknown> {
  const client = clientWith(
    testCase.canned === 'refused' ? refuseConnection() : replay(testCase.canned),
  );
  const command =
    testCase.verb === 'get'
      ? new GetObjectCommand({ Bucket: 'navroop-test', Key: 'snapshots/p/c.json.gz' })
      : new HeadObjectCommand({ Bucket: 'navroop-test', Key: 'snapshots/p/c.json.gz' });
  try {
    await client.send(command);
  } catch (error) {
    return error;
  }
  throw new Error(`${testCase.label} did not raise, so there is nothing to classify`);
}

function statusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('$metadata' in error)) return null;
  const metadata = (error as { $metadata: { httpStatusCode?: unknown } }).$metadata;
  return typeof metadata?.httpStatusCode === 'number' ? metadata.httpStatusCode : null;
}

function nameOf(error: unknown) {
  return error instanceof Error ? error.name : String(error);
}

describe('what the installed SDK raises for a missing object', () => {
  for (const testCase of CASES) {
    it(`${testCase.label} -> ${testCase.name}`, async () => {
      const error = await raise(testCase);
      // Pin the SDK behaviour the classifier is built on, so an upgrade that changes it
      // fails here rather than turning into a wrong answer three layers up.
      expect(nameOf(error)).toBe(testCase.name);
      expect(statusOf(error)).toBe(testCase.status);
      expect(isObjectNotFoundError(error)).toBe(testCase.absent);
    });
  }

  it('recognises absence on both verbs, not just GET', async () => {
    // A rule written only against GET would miss HEAD entirely: a HEAD 404 can never say
    // NoSuchKey, and `exists` is the only caller of HeadObject.
    const absent = CASES.filter((row) => row.absent);
    expect(absent.filter((row) => row.verb === 'head').length).toBeGreaterThan(0);
    expect(absent.filter((row) => row.verb === 'get').length).toBeGreaterThan(1);
    for (const row of absent) {
      expect(isObjectNotFoundError(await raise(row)), row.label).toBe(true);
    }
  });
});

describe('controls: the two rules that look right and are not', () => {
  /** The code being replaced: `catch { return null }` treats any failure as absence. */
  const bareCatch = () => true;
  /** The obvious fix: trust the status code alone. Wrong for a bucket-level 404. */
  const statusOnly = (error: unknown) => statusOf(error) === 404;

  it('the bare catch called every one of these failures an absent object', async () => {
    const failures = CASES.filter((row) => !row.absent);
    expect(failures.length).toBeGreaterThan(5);
    for (const row of failures) {
      const error = await raise(row);
      expect(bareCatch(), row.label).toBe(true);
      expect(isObjectNotFoundError(error), row.label).toBe(false);
    }
  });

  it('a status-only rule mistakes a missing bucket for a missing object', async () => {
    const wrongBucket = CASES.find((row) => row.name === 'NoSuchBucket');
    expect(wrongBucket).toBeDefined();
    if (!wrongBucket) return;
    const error = await raise(wrongBucket);
    expect(statusOnly(error)).toBe(true);
    expect(isObjectNotFoundError(error)).toBe(false);
  });

  it('a name-only rule cannot see a HEAD 404', async () => {
    const headMissing = CASES.find((row) => row.verb === 'head' && row.absent);
    expect(headMissing).toBeDefined();
    if (!headMissing) return;
    const error = await raise(headMissing);
    // The SDK names it NotFound with no S3 error code, which is why the classifier
    // checks the status too.
    expect(nameOf(error)).toBe('NotFound');
    expect(statusOf(error)).toBe(404);
    expect(isObjectNotFoundError(error)).toBe(true);
  });
});
