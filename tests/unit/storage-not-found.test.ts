import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The storage contract, on the s3 driver: `get` answers `null` and `exists` answers
 * `false` only for an object that is genuinely absent. Every other failure throws.
 *
 * Before this, both used a bare `catch`, so rejected credentials, a throttled request, a
 * misnamed bucket and an unreachable endpoint all read as "that object is not there".
 * `readSnapshot` then turned the `null` into an empty array — `Checkpoint.fileSnapshot`
 * is legacy-read-only and null for every checkpoint written since the object-storage
 * migration — and five callers each converted the empty array into a different confident
 * wrong answer. None of it reproduces on the local driver, whose `localGet` already got
 * this right.
 *
 * The SDK is stubbed at `S3Client.send`, so nothing here can reach ElasticLake or S3.
 * The error objects are the real exception classes, and the identity of the exception the
 * SDK raises per HTTP response is verified separately, against a real deserializer, in
 * tests/unit/s3-not-found.test.ts.
 *
 * Goes red if: a bare `catch` comes back in `s3Get` / `s3Exists` (the throw expectations
 * fail); the classifier stops recognising `NoSuchKey` or a HEAD 404 (the null / false
 * expectations fail); or `readSnapshot` starts answering `[]` for a failed read again.
 */

const sdk = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return {
    ...actual,
    S3Client: class StubbedS3Client {
      readonly send = sdk.send;
    },
  };
});

const { NoSuchKey, NotFound, NoSuchBucket, S3ServiceException } = await import('@aws-sdk/client-s3');
const { get, exists } = await import('@/lib/storage/index.ts');
const { asFileSnapshot, readSnapshot, SnapshotReadError } = await import(
  '@/lib/checkpoints/snapshot-store.ts'
);

const KEY = 'snapshots/proj_read/cp_read.json.gz';

const FILES = [
  { path: 'package.json', content: '{"name":"navroop-demo"}' },
  { path: 'src/App.jsx', content: 'export default function App(){return <h1>Current</h1>}' },
];

function absentKey() {
  return new NoSuchKey({ $metadata: { httpStatusCode: 404 }, message: 'The specified key does not exist.' });
}

/** What a HEAD on a missing key produces: a 404 with no body to name. */
function absentHead() {
  return new NotFound({ $metadata: { httpStatusCode: 404 }, message: 'UnknownError' });
}

function accessDenied() {
  return new S3ServiceException({
    name: 'AccessDenied',
    $fault: 'client',
    $metadata: { httpStatusCode: 403 },
    message: 'Access Denied',
  });
}

function throttled() {
  return new S3ServiceException({
    name: 'SlowDown',
    $fault: 'client',
    $metadata: { httpStatusCode: 503 },
    message: 'Please reduce your request rate.',
  });
}

/** A HEAD failure the service could not describe, because a HEAD has no body. */
function unnamedHeadFailure(status: number) {
  return new S3ServiceException({
    name: 'Unknown',
    $fault: status >= 500 ? 'server' : 'client',
    $metadata: { httpStatusCode: status },
    message: 'UnknownError',
  });
}

function wrongBucket() {
  return new NoSuchBucket({
    $metadata: { httpStatusCode: 404 },
    message: 'The specified bucket does not exist.',
  });
}

function unreachable() {
  return Object.assign(new Error('connect ECONNREFUSED 10.0.0.4:9000'), { code: 'ECONNREFUSED' });
}

function bodyOf(buffer: Buffer) {
  return { Body: { transformToByteArray: async () => new Uint8Array(buffer) } };
}

const ENV_KEYS = [
  'STORAGE_DRIVER',
  'ELK_ENDPOINT',
  'ELK_BUCKET',
  'ELK_ACCESS_KEY_ID',
  'ELK_SECRET_ACCESS_KEY',
] as const;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  process.env.STORAGE_DRIVER = 's3';
  process.env.ELK_ENDPOINT = 'http://elk.invalid';
  process.env.ELK_BUCKET = 'navroop-test';
  process.env.ELK_ACCESS_KEY_ID = 'test-only';
  process.env.ELK_SECRET_ACCESS_KEY = 'test-only';
  sdk.send.mockReset();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('get() on the s3 driver', () => {
  it('answers null for a key that is not in the bucket', async () => {
    sdk.send.mockRejectedValue(absentKey());
    expect(await get(KEY)).toBeNull();
  });

  it('answers null for a 404 with no error body', async () => {
    sdk.send.mockRejectedValue(absentHead());
    expect(await get(KEY)).toBeNull();
  });

  it('returns the object body when the read succeeds', async () => {
    const payload = gzipSync(Buffer.from(JSON.stringify(FILES), 'utf8'));
    sdk.send.mockResolvedValue(bodyOf(payload));
    const body = await get(KEY);
    expect(body).not.toBeNull();
    expect(body?.equals(payload)).toBe(true);
  });

  for (const [label, makeError] of [
    ['rejected credentials', accessDenied],
    ['a throttled request', throttled],
    ['a bucket that does not exist', wrongBucket],
    ['an unreachable endpoint', unreachable],
    ['a broken service', () => unnamedHeadFailure(500)],
  ] as const) {
    it(`throws on ${label} instead of reporting the object as gone`, async () => {
      sdk.send.mockRejectedValue(makeError());
      await expect(get(KEY)).rejects.toThrow();
    });
  }

  it('throws when the body stream dies part way through', async () => {
    // A truncated download is not an absent object either.
    sdk.send.mockResolvedValue({
      Body: {
        transformToByteArray: async () => {
          throw new Error('aborted');
        },
      },
    });
    await expect(get(KEY)).rejects.toThrow('aborted');
  });
});

describe('exists() on the s3 driver', () => {
  it('answers false for a HEAD 404', async () => {
    sdk.send.mockRejectedValue(absentHead());
    expect(await exists(KEY)).toBe(false);
  });

  it('answers true when the HEAD succeeds', async () => {
    sdk.send.mockResolvedValue({ ContentLength: 12 });
    expect(await exists(KEY)).toBe(true);
  });

  for (const [label, status] of [
    ['rejected credentials', 403],
    ['a broken service', 500],
    ['a rejected request', 400],
  ] as const) {
    it(`throws on ${label} instead of reporting the object as missing`, async () => {
      sdk.send.mockRejectedValue(unnamedHeadFailure(status));
      await expect(exists(KEY)).rejects.toThrow();
    });
  }
});

describe('readSnapshot() over the s3 driver', () => {
  it('reads the files back when storage answers', async () => {
    sdk.send.mockResolvedValue(bodyOf(gzipSync(Buffer.from(JSON.stringify(FILES), 'utf8'))));
    const files = await readSnapshot({ snapshotKey: KEY, fileSnapshot: null });
    expect(files.map((file) => file.path)).toEqual(['package.json', 'src/App.jsx']);
  });

  it('reads a genuinely deleted snapshot as empty, which is what pruning means', async () => {
    sdk.send.mockRejectedValue(absentKey());
    expect(await readSnapshot({ snapshotKey: KEY, fileSnapshot: null })).toEqual([]);
  });

  it('throws SnapshotReadError when storage fails, rather than answering empty', async () => {
    sdk.send.mockRejectedValue(accessDenied());
    await expect(readSnapshot({ snapshotKey: KEY, fileSnapshot: null })).rejects.toBeInstanceOf(
      SnapshotReadError,
    );
  });

  it('throws on a damaged snapshot object with no legacy Json behind it', async () => {
    // Not gzip. Reporting zero files here would read to every caller as pruned.
    sdk.send.mockResolvedValue(bodyOf(Buffer.from('this is not gzip', 'utf8')));
    await expect(readSnapshot({ snapshotKey: KEY, fileSnapshot: null })).rejects.toBeInstanceOf(
      SnapshotReadError,
    );
  });

  it('still falls back to legacy Json when the object is damaged but the row has one', async () => {
    sdk.send.mockResolvedValue(bodyOf(Buffer.from('this is not gzip', 'utf8')));
    const files = await readSnapshot({ snapshotKey: KEY, fileSnapshot: FILES });
    expect(files).toHaveLength(2);
  });

  it('never asks storage when the row has no snapshotKey', async () => {
    sdk.send.mockRejectedValue(accessDenied());
    expect(await readSnapshot({ snapshotKey: null, fileSnapshot: FILES })).toHaveLength(2);
    expect(sdk.send).not.toHaveBeenCalled();
  });
});

describe('control: the code as it was', () => {
  /** `s3Get` before the fix — a bare catch around the whole send. */
  async function oldS3Get(): Promise<Buffer | null> {
    try {
      const response = await sdk.send();
      if (!response?.Body) return null;
      return Buffer.from(await response.Body.transformToByteArray());
    } catch {
      return null;
    }
  }

  /** `readSnapshot` before the fix, over that `get`. */
  async function oldReadSnapshot(record: { snapshotKey: string | null; fileSnapshot: unknown }) {
    if (record.snapshotKey) {
      const body = await oldS3Get();
      if (body) return asFileSnapshot(JSON.parse(body.toString('utf8')));
    }
    return asFileSnapshot(record.fileSnapshot);
  }

  it('answered "no files" for a permissions failure, and the fix does not', async () => {
    sdk.send.mockRejectedValue(accessDenied());

    // The bug, reproduced: a checkpoint that certainly has files reads as having none.
    expect(await oldReadSnapshot({ snapshotKey: KEY, fileSnapshot: null })).toEqual([]);

    // Same input, same error, through the shipped code.
    await expect(readSnapshot({ snapshotKey: KEY, fileSnapshot: null })).rejects.toBeInstanceOf(
      SnapshotReadError,
    );
  });

  it('was indistinguishable from a pruned snapshot, and now is not', async () => {
    sdk.send.mockRejectedValue(absentKey());
    const pruned = await oldReadSnapshot({ snapshotKey: KEY, fileSnapshot: null });

    sdk.send.mockRejectedValue(accessDenied());
    const failed = await oldReadSnapshot({ snapshotKey: KEY, fileSnapshot: null });

    // Two different situations, one answer. That is the whole defect.
    expect(failed).toEqual(pruned);

    // The shipped code separates them: one value, one throw.
    sdk.send.mockRejectedValue(absentKey());
    expect(await readSnapshot({ snapshotKey: KEY, fileSnapshot: null })).toEqual([]);
    sdk.send.mockRejectedValue(accessDenied());
    await expect(readSnapshot({ snapshotKey: KEY, fileSnapshot: null })).rejects.toBeInstanceOf(
      SnapshotReadError,
    );
  });
});
