import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createApplication,
  deleteApplication,
  getApplication,
  getCoolifyDeployment,
  listApplications,
  setApplicationEnvVars,
  setApplicationPrimaryRedirects,
  stopApplication,
  testServerConnection,
  triggerDeploy,
  type CoolifyServerAuth,
  type CreateApplicationInput,
} from '@/lib/coolify/client';
import { CoolifyApiError } from '@/lib/coolify/errors';

/**
 * Which Coolify calls the transport is allowed to send twice.
 *
 * `coolifyFetch` used to retry any `status >= 500` regardless of method. A 502 from a
 * proxy that arrived *after* Coolify had created the application therefore re-POSTed
 * `/api/v1/applications/public`, and only one of the two uuids was ever recorded: the
 * duplicate ran and billed forever with nothing in the product pointing at it, because
 * `lib/publish/cleanup.ts` and `lib/jobs/orphans.ts` delete strictly by recorded
 * provenance. The same double-send on the `domains` PATCH turns two interleaved
 * read-modify-writes into a dropped hostname (F-215).
 *
 * Retrying is now opt-in per call site and enabled only on pure reads. These cases pin
 * the split at the wire: the exact sequence of requests, not just the outcome. Note the
 * two GETs that MUTATE — `/api/v1/deploy` and `/applications/{uuid}/stop` — which is why
 * the decision can never go back to sniffing the method.
 */

const SERVER: CoolifyServerAuth = {
  apiUrl: 'https://coolify.example.test',
  // Short and unpadded, so `tokenForServer` passes it through instead of calling decrypt.
  apiToken: 'plain-token',
};

const APP = 'app-1';

const CREATE_INPUT: CreateApplicationInput = {
  repoUrl: 'https://github.com/navroop/deploy-app-1.git',
  branch: 'main',
  domain: 'app-1.navroop.example.test',
  deployType: 'static',
  buildCommand: null,
  outputDir: null,
  startCommand: null,
  port: null,
  name: 'deploy-app-1',
  projectUuid: 'proj-1',
  serverIp: '203.0.113.10',
};

type Attempt = { url: string; method: string };

let attempts: Attempt[] = [];

/** `handler` receives how many identical requests were already sent, so a case can 502 once. */
function stubFetch(handler: (attempt: Attempt, prior: number) => Response) {
  attempts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const attempt = { url: String(input), method: String(init?.method ?? 'GET').toUpperCase() };
      const prior = attempts.filter(
        (seen) => seen.url === attempt.url && seen.method === attempt.method,
      ).length;
      attempts.push(attempt);
      return handler(attempt, prior);
    }),
  );
}

function trace() {
  return attempts.map((attempt) => {
    const url = new URL(attempt.url);
    return `${attempt.method} ${url.pathname}${url.search}`;
  });
}

function badGateway() {
  return Response.json({ message: 'Bad gateway' }, { status: 502 });
}

async function failure(run: () => Promise<unknown>) {
  const error = await run().then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(CoolifyApiError);
  return error as CoolifyApiError;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mutating Coolify calls are sent exactly once', () => {
  it('never re-POSTs an application create after a 502', async () => {
    stubFetch((attempt) => {
      if (attempt.url.endsWith('/api/v1/applications')) return Response.json([]);
      if (attempt.url.endsWith('/api/v1/servers')) {
        return Response.json([{ uuid: 'srv-1', ip: '203.0.113.10' }]);
      }
      if (attempt.url.endsWith('/api/v1/applications/public')) return badGateway();
      return Response.json({ message: 'unexpected' }, { status: 418 });
    });

    const error = await failure(() => createApplication(SERVER, CREATE_INPUT));

    expect(error.status).toBe(502);
    expect(trace()).toEqual([
      'GET /api/v1/applications',
      'GET /api/v1/servers',
      'POST /api/v1/applications/public',
    ]);
  });

  it('never re-PATCHes the domain list after a 502', async () => {
    stubFetch(() => badGateway());

    const error = await failure(() =>
      setApplicationPrimaryRedirects(SERVER, APP, 'primary.example.test', ['alias.example.test']),
    );

    expect(error.status).toBe(502);
    expect(trace()).toEqual(['PATCH /api/v1/applications/app-1']);
  });

  it('never re-sends the application DELETE after a 502', async () => {
    stubFetch(() => badGateway());

    const error = await failure(() => deleteApplication(SERVER, APP));

    expect(error.status).toBe(502);
    expect(trace()).toEqual(['DELETE /api/v1/applications/app-1']);
  });

  it('never re-triggers a deploy, even though the call is a GET', async () => {
    stubFetch(() => badGateway());

    const error = await failure(() => triggerDeploy(SERVER, APP));

    expect(error.status).toBe(502);
    expect(trace()).toEqual(['GET /api/v1/deploy?uuid=app-1&force=true']);
  });

  it('never re-sends the stop call, even though the call is a GET', async () => {
    stubFetch(() => badGateway());

    const error = await failure(() => stopApplication(SERVER, APP));

    expect(error.status).toBe(502);
    expect(trace()).toEqual(['GET /api/v1/applications/app-1/stop']);
  });

  it('falls the env-var POST through to the update PATCH without retrying either', async () => {
    stubFetch((attempt) =>
      attempt.method === 'POST' ? badGateway() : Response.json({ ok: true }),
    );

    await setApplicationEnvVars(SERVER, APP, { PREVIEW_PASSWORD: 'pw-1' });

    expect(trace()).toEqual([
      'POST /api/v1/applications/app-1/envs',
      'PATCH /api/v1/applications/app-1/envs/update',
    ]);
  });
});

describe('idempotent reads absorb one 5xx', () => {
  it('retries the application listing once', async () => {
    stubFetch((_attempt, prior) => (prior === 0 ? badGateway() : Response.json([])));

    await expect(listApplications(SERVER)).resolves.toEqual([]);
    expect(trace()).toEqual(['GET /api/v1/applications', 'GET /api/v1/applications']);
  });

  it('retries the single-application read once', async () => {
    stubFetch((_attempt, prior) =>
      prior === 0 ? badGateway() : Response.json({ uuid: APP, fqdn: 'https://a.example.test' }),
    );

    await expect(getApplication(SERVER, APP)).resolves.toMatchObject({ uuid: APP });
    expect(trace()).toEqual(['GET /api/v1/applications/app-1', 'GET /api/v1/applications/app-1']);
  });

  it('retries the deployment poll once', async () => {
    stubFetch((_attempt, prior) =>
      prior === 0 ? badGateway() : Response.json({ status: 'finished' }),
    );

    await expect(getCoolifyDeployment(SERVER, 'dep-1')).resolves.toMatchObject({
      health: 'healthy',
      status: 'finished',
    });
    expect(trace()).toEqual(['GET /api/v1/deployments/dep-1', 'GET /api/v1/deployments/dep-1']);
  });

  it('retries the version probe once', async () => {
    stubFetch((_attempt, prior) =>
      prior === 0 ? badGateway() : Response.json({ version: '4.0.0' }),
    );

    await expect(testServerConnection(SERVER)).resolves.toMatchObject({
      ok: true,
      version: '4.0.0',
    });
    expect(trace()).toEqual(['GET /api/v1/version', 'GET /api/v1/version']);
  });

  it('retries the server lookup once, then still creates exactly one application', async () => {
    stubFetch((attempt, prior) => {
      if (attempt.url.endsWith('/api/v1/applications')) return Response.json([]);
      if (attempt.url.endsWith('/api/v1/servers')) {
        return prior === 0 ? badGateway() : Response.json([{ uuid: 'srv-1', ip: '203.0.113.10' }]);
      }
      return Response.json({ uuid: 'created-1' });
    });

    await expect(createApplication(SERVER, CREATE_INPUT)).resolves.toMatchObject({
      uuid: 'created-1',
    });
    expect(trace()).toEqual([
      'GET /api/v1/applications',
      'GET /api/v1/servers',
      'GET /api/v1/servers',
      'POST /api/v1/applications/public',
    ]);
  });

  it('is bounded: a read that keeps failing stops after the single retry', async () => {
    stubFetch(() => badGateway());

    const error = await failure(() => listApplications(SERVER));

    expect(error.status).toBe(502);
    expect(trace()).toEqual(['GET /api/v1/applications', 'GET /api/v1/applications']);
  });

  it('does not retry a 4xx, which is an answer rather than a transport failure', async () => {
    stubFetch(() => Response.json({ message: 'Unauthenticated.' }, { status: 401 }));

    const error = await failure(() => listApplications(SERVER));

    expect(error.status).toBe(401);
    expect(trace()).toEqual(['GET /api/v1/applications']);
  });
});
