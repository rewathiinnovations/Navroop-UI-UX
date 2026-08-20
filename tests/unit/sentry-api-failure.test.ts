/**
 * F-631: a failed Sentry API call must be a distinct failure, never a healthy,
 * quiet project. `createSentryApi` rejects with a typed error, and the quota
 * check records `skipped: sentry API unreachable` — it must not send the
 * heartbeat-mismatch email when the API call itself was what failed.
 */
import { describe, expect, it } from 'vitest';
import { runObservabilityQuotaCheck } from '../../lib/observability/quota';
import { SentryApiError, createSentryApi } from '../../lib/observability/sentry-api';
import type { ObservabilityCheckRow, ObservabilityEmail } from '../../lib/observability/types';

function memoryStore() {
  const checks: ObservabilityCheckRow[] = [];
  return {
    checks,
    async createCheck(row: Omit<ObservabilityCheckRow, 'id'> & { id?: string }) {
      const created: ObservabilityCheckRow = {
        id: row.id ?? `chk_${checks.length + 1}`,
        kind: row.kind,
        ok: row.ok,
        detail: row.detail ?? null,
        eventId: row.eventId ?? null,
        createdAt: row.createdAt,
      };
      checks.push(created);
      return created;
    },
    async listChecks(kind?: string) {
      return kind ? checks.filter((row) => row.kind === kind) : checks.slice();
    },
  };
}

const creds = { authToken: 'test-key', orgSlug: 'navroop', projectSlug: 'app' };

describe('createSentryApi failure is a rejection, not zeros', () => {
  it('getProjectStats rejects with SentryApiError when fetch itself fails', async () => {
    const api = createSentryApi(creds, async () => {
      throw new TypeError('fetch failed');
    });
    await expect(api.getProjectStats()).rejects.toBeInstanceOf(SentryApiError);
    await expect(api.getProjectStats()).rejects.toThrowError(/unreachable/i);
  });

  it('getProjectStats rejects with SentryApiError on a non-2xx response', async () => {
    const api = createSentryApi(creds, async () => new Response('{}', { status: 401 }));
    await expect(api.getProjectStats()).rejects.toBeInstanceOf(SentryApiError);
    await expect(api.getProjectStats()).rejects.toThrowError(/HTTP 401/);
  });

  it('findIssueByFingerprint rejects instead of returning null on failure', async () => {
    const api = createSentryApi(creds, async () => new Response('{}', { status: 403 }));
    await expect(api.findIssueByFingerprint('navroop-heartbeat')).rejects.toBeInstanceOf(
      SentryApiError,
    );
  });
});

describe('quota check on Sentry API failure', () => {
  it('records a skip, returns not-ok, and sends no mismatch email', async () => {
    const store = memoryStore();
    const emails: ObservabilityEmail[] = [];
    // A recent successful local heartbeat: the exact setup that used to turn an
    // unreachable API into a false "heartbeat mismatch" alert.
    store.checks.push({
      id: 'local',
      kind: 'heartbeat',
      ok: true,
      detail: 'flush ok',
      eventId: 'evt_local',
      createdAt: new Date('2026-08-17T11:00:00.000Z'),
    });
    const result = await runObservabilityQuotaCheck({
      credentials: creds,
      now: new Date('2026-08-17T12:00:00.000Z'),
      store,
      sentryApi: {
        getProjectStats: async () => {
          throw new SentryApiError('Sentry API HTTP 401');
        },
        findIssueByFingerprint: async () => {
          throw new SentryApiError('Sentry API HTTP 401');
        },
      },
      sendAdminEmail: async (mail) => {
        emails.push(mail);
      },
    });

    expect(result.status).toBe('skipped');
    expect(result.ok).toBe(false);
    expect(emails).toHaveLength(0);
    const quotaChecks = store.checks.filter((row) => row.kind === 'quota');
    expect(quotaChecks).toHaveLength(1);
    expect(quotaChecks[0].ok).toBe(false);
    expect(String(quotaChecks[0].detail)).toMatch(/skipped: sentry API unreachable/i);
    expect(String(quotaChecks[0].detail)).toMatch(/HTTP 401/);
  });
});
