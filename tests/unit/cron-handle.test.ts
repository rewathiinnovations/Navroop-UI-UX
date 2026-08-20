import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCron } from '../../lib/cron/handle';

/**
 * Cron responses previously carried no correlation id, so a failing scheduled
 * job could not be tied to anything in the logs. These pin the shapes.
 */

const recorded: Array<{ name: string; ok: boolean; detail: string | null }> = [];

vi.mock('../../lib/observability/store', () => ({
  getObservabilityStore: () => ({
    createCronRun: async (row: { name: string; ok: boolean; detail: string | null }) => {
      recorded.push({ name: row.name, ok: row.ok, detail: row.detail });
    },
  }),
}));

/**
 * `handleCron` now claims an in-flight marker before it runs the body (F-708). This file is
 * about status codes and correlation ids, so the claim is stubbed rather than letting these
 * unit tests reach Postgres; the claim's own behaviour is covered by
 * `tests/unit/cron-overlap.test.ts`.
 */
const released: string[] = [];
vi.mock('../../lib/cron/claim', () => ({
  getCronClaimStore: () => ({
    claim: async (name: string, now: Date) => ({
      claimed: true as const,
      abandoned: null,
      claim: {
        runId: 'test-run',
        startedAt: now.toISOString(),
        release: async () => {
          released.push(name);
        },
      },
    }),
  }),
}));

const SECRET = 'cron-test';

function cronRequest(authorization?: string) {
  return new Request('http://localhost:3000/api/cron/reap-jobs', {
    method: 'POST',
    headers: authorization ? { authorization } : {},
  });
}

let previousSecret: string | undefined;

beforeEach(() => {
  recorded.length = 0;
  released.length = 0;
  previousSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = SECRET;
});

afterEach(() => {
  if (previousSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = previousSecret;
});

describe('cron authorization', () => {
  it('rejects a missing bearer token with a 401 carrying a request id', async () => {
    const response = await handleCron('reap-jobs', cronRequest(), async () => ({ ok: true }));
    expect(response.status).toBe(401);
    expect(response.headers.get('x-request-id')).toBeTruthy();

    const body = (await response.json()) as {
      error: { message: string; code: string; requestId: string };
    };
    expect(body.error).toMatchObject({ message: 'Unauthorized', code: 'UNAUTHORIZED' });
    expect(body.error.requestId).toBe(response.headers.get('x-request-id'));
  });

  it('rejects a wrong bearer token', async () => {
    const response = await handleCron('reap-jobs', cronRequest('Bearer wrong'), async () => ({
      ok: true,
    }));
    expect(response.status).toBe(401);
  });

  it('does not run the job or record a run when unauthorized', async () => {
    let ran = false;
    await handleCron('reap-jobs', cronRequest('Bearer wrong'), async () => {
      ran = true;
      return { ok: true };
    });
    expect(ran).toBe(false);
    expect(recorded).toEqual([]);
  });

  it('runs the job with a valid bearer token', async () => {
    const response = await handleCron('reap-jobs', cronRequest(`Bearer ${SECRET}`), async () => ({
      ok: true,
      reaped: 2,
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, reaped: 2 });
    expect(recorded).toEqual([{ name: 'reap-jobs', ok: true, detail: null }]);
    expect(released).toEqual(['reap-jobs']);
  });
});

describe('cron failure shapes', () => {
  it('returns a 500 with a request id when the job throws', async () => {
    const response = await handleCron('reap-jobs', cronRequest(`Bearer ${SECRET}`), async () => {
      throw new Error('boom');
    });
    expect(response.status).toBe(500);
    const body = (await response.json()) as {
      error: { message: string; code: string; requestId: string };
    };
    expect(body.error).toMatchObject({ message: 'boom', code: 'CRON_FAILED' });
    expect(body.error.requestId).toBe(response.headers.get('x-request-id'));
    expect(recorded).toEqual([{ name: 'reap-jobs', ok: false, detail: 'boom' }]);
  });

  it('passes a self-reported failure body through but adds the request id', async () => {
    const response = await handleCron('reap-jobs', cronRequest(`Bearer ${SECRET}`), async () => ({
      ok: false,
      error: 'partial',
      skipped: 3,
    }));
    expect(response.status).toBe(500);
    // Diagnostic fields are kept: the cron chose this body deliberately.
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'partial', skipped: 3 });
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });

  it('reuses an inbound request id on a self-reported failure', async () => {
    const request = new Request('http://localhost:3000/api/cron/reap-jobs', {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}`, 'x-request-id': 'cron-inbound-1' },
    });
    const response = await handleCron('reap-jobs', request, async () => ({ ok: false }));
    expect(response.headers.get('x-request-id')).toBe('cron-inbound-1');
  });
});
