import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runHealthChecks } from '../../lib/health/check';
import { allowEmail, clearEmailRateLimits } from '../../lib/email/rate-limit';
import { sendEmail } from '../../lib/email/client';
import { withCronRun } from '../../lib/cron/record';
import {
  HEARTBEAT_FINGERPRINT,
  sendObservabilityHeartbeat,
} from '../../lib/observability/heartbeat';
import { runObservabilityQuotaCheck } from '../../lib/observability/quota';
import { runObservabilityStartup } from '../../lib/observability/startup';
import {
  buildErrorTrackingPanel,
  sendObservabilityTestEvent,
} from '../../lib/observability/admin';
import {
  CRON_STALE_MS,
  evaluateSystemChecks,
  sendSystemChecksDigest,
} from '../../lib/observability/system-checks';
import {
  clearNoiseBuckets,
  observabilityBeforeSend,
  shouldCaptureException,
} from '../../lib/observability/noise';
import { trackFailure } from '../../lib/observability/track';
import type { ObservabilityCheckRow, CronRunRow } from '../../lib/observability/types';

function memoryStore() {
  const checks: ObservabilityCheckRow[] = [];
  const crons: CronRunRow[] = [];
  return {
    checks,
    crons,
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
    async createCronRun(row: Omit<CronRunRow, 'id'> & { id?: string }) {
      const created: CronRunRow = {
        id: row.id ?? `cron_${crons.length + 1}`,
        name: row.name,
        ok: row.ok,
        durationMs: row.durationMs ?? null,
        detail: row.detail ?? null,
        createdAt: row.createdAt,
      };
      crons.push(created);
      return created;
    },
    async listCronRuns() {
      return crons.slice();
    },
  };
}

const okDb = {
  async $queryRaw() {
    return [{ ok: 1 }];
  },
};

describe('observability heartbeat', () => {
  it('records a heartbeat row with whether flush reported success', async () => {
    const store = memoryStore();
    const result = await sendObservabilityHeartbeat({
      captureMessage: () => 'evt_hb',
      flush: async () => true,
      instanceId: 'inst-1',
      environment: 'test',
      releaseSha: 'abc123',
      now: new Date('2026-08-17T12:00:00.000Z'),
      store,
    });
    expect(result.eventId).toBe('evt_hb');
    expect(result.flushOk).toBe(true);
    expect(result.fingerprint).toBe(HEARTBEAT_FINGERPRINT);
    expect(store.checks[0]).toMatchObject({
      kind: 'heartbeat',
      ok: true,
      eventId: 'evt_hb',
    });
    expect(String(store.checks[0].detail)).toMatch(/flush/i);
  });

  it('records flush failure and emails after two consecutive send failures', async () => {
    const store = memoryStore();
    const emails: Array<{ subject: string; text: string; emailClass?: string }> = [];
    const deps = {
      captureMessage: () => 'evt_fail',
      flush: async () => false,
      instanceId: 'inst-1',
      environment: 'production',
      releaseSha: 'abc123',
      store,
      sendAdminEmail: async (mail: { subject: string; text: string; emailClass?: string }) => {
        emails.push(mail);
      },
    };
    await sendObservabilityHeartbeat({ ...deps, now: new Date('2026-08-17T12:00:00.000Z') });
    expect(emails).toHaveLength(0);
    expect(store.checks[0]?.ok).toBe(false);
    await sendObservabilityHeartbeat({ ...deps, now: new Date('2026-08-17T13:00:00.000Z') });
    expect(emails.length).toBeGreaterThan(0);
    expect(emails[0].emailClass).toBe('security');
    expect(emails[0].text).toMatch(/heartbeat/i);
  });
});

describe('observability quota', () => {
  it('records skipped when AUTH_TOKEN is missing — never a silent pass', async () => {
    const store = memoryStore();
    let apiCalls = 0;
    const result = await runObservabilityQuotaCheck({
      credentials: { orgSlug: 'navroop', projectSlug: 'app' },
      now: new Date('2026-08-17T12:00:00.000Z'),
      store,
      sentryApi: {
        getProjectStats: async () => {
          apiCalls += 1;
          return {
            accepted: 1,
            dropped: [],
            quota: { used: 1, limit: 100, resetsAt: null },
            topIssues: [],
          };
        },
        findIssueByFingerprint: async () => null,
      },
    });
    expect(result.status).toBe('skipped');
    expect(result.ok).toBe(false);
    expect(apiCalls).toBe(0);
    expect(store.checks[0]).toMatchObject({ kind: 'quota', ok: false });
    expect(String(store.checks[0].detail)).toMatch(/skipped/i);
  });

  it('alerts when local send is ok but Sentry lastSeen is older than 3h', async () => {
    const store = memoryStore();
    const emails: Array<{ text: string; emailClass?: string }> = [];
    store.checks.push({
      id: 'local',
      kind: 'heartbeat',
      ok: true,
      detail: 'flush ok',
      eventId: 'evt_local',
      createdAt: new Date('2026-08-17T12:00:00.000Z'),
    });
    const result = await runObservabilityQuotaCheck({
      credentials: {
        authToken: 'token',
        orgSlug: 'navroop',
        projectSlug: 'wrong-project',
      },
      now: new Date('2026-08-17T16:00:00.000Z'),
      store,
      sentryApi: {
        getProjectStats: async () => ({
          accepted: 0,
          dropped: [],
          quota: { used: 0, limit: 100, resetsAt: null },
          topIssues: [],
        }),
        findIssueByFingerprint: async () => ({
          id: 'issue_1',
          lastSeen: '2026-08-17T10:00:00.000Z',
        }),
      },
      sendAdminEmail: async (mail) => {
        emails.push(mail);
      },
    });
    expect(result.status).toBe('mismatch');
    expect(emails.length).toBeGreaterThan(0);
    expect(emails[0].text).toMatch(/quota|rate limit|inbound filter|DSN/i);
    expect(store.checks.some((row) => row.kind === 'quota')).toBe(true);
  });

  it('warns when quota is above 80% and emails consumption plus top 3 issues', async () => {
    const store = memoryStore();
    const emails: Array<{ text: string }> = [];
    const result = await runObservabilityQuotaCheck({
      credentials: {
        authToken: 'token',
        orgSlug: 'navroop',
        projectSlug: 'app',
      },
      now: new Date('2026-08-17T12:00:00.000Z'),
      store,
      sentryApi: {
        getProjectStats: async () => ({
          accepted: 850,
          dropped: [{ reason: 'rate_limit', count: 2 }],
          quota: { used: 85, limit: 100, resetsAt: '2026-09-01T00:00:00.000Z' },
          topIssues: [
            { id: '1', title: 'Boom A', count: 40 },
            { id: '2', title: 'Boom B', count: 20 },
            { id: '3', title: 'Boom C', count: 10 },
          ],
        }),
        findIssueByFingerprint: async () => ({
          id: 'hb',
          lastSeen: '2026-08-17T11:50:00.000Z',
        }),
      },
      sendAdminEmail: async (mail) => {
        emails.push(mail);
      },
    });
    expect(result.quotaWarning).toBe(true);
    expect(emails.some((mail) => /85/.test(mail.text) && /Boom A/.test(mail.text))).toBe(true);
  });
});

describe('observability startup and health', () => {
  it('warns, records dsn_config false, emails, and still runs when DSN is missing in production', async () => {
    const store = memoryStore();
    const warnings: string[] = [];
    const emails: Array<{ text: string; emailClass?: string }> = [];
    const result = await runObservabilityStartup({
      nodeEnv: 'production',
      dsn: '',
      environment: 'production',
      releaseSha: 'deadbeef',
      now: new Date('2026-08-17T12:00:00.000Z'),
      store,
      warn: (message) => warnings.push(message),
      sendAdminEmail: async (mail) => {
        emails.push(mail);
      },
    });
    expect(result.ran).toBe(true);
    expect(result.dsnConfigured).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
    expect(emails.length).toBeGreaterThan(0);
    expect(emails[0].emailClass).toBe('security');
    expect(store.checks[0]).toMatchObject({ kind: 'dsn_config', ok: false });
  });

  it('includes DSN presence and release sha on GET health', async () => {
    const result = await runHealthChecks({
      db: okDb,
      storageHead: async () => true,
      now: 1_000,
      startedAt: 0,
      version: '0.1.0',
      sentryDsnConfigured: false,
      releaseSha: 'abc123def',
      sentryEnvironment: 'production',
    });
    expect(result.ok).toBe(true);
    expect(result.sentry?.dsnConfigured).toBe(false);
    expect(result.sentry?.releaseSha).toBe('abc123def');
    expect(result.sentry?.environment).toBe('production');
  });

  it('names the data directory state so an unprobed volume is not read as a missing one', async () => {
    const base = {
      db: okDb,
      storageHead: async () => true,
      now: 1_000,
      startedAt: 0,
      version: '0.1.0',
      sentryDsnConfigured: false,
      releaseSha: 'abc123def',
      sentryEnvironment: 'production',
    };
    const status = {
      checked: false,
      path: '/data',
      writable: false,
      error: null,
      volumeId: null,
      volumeCreatedAt: null,
      volumeChanged: false,
      previousVolumeId: null,
      freeBytes: null,
      totalBytes: null,
      freeRatio: null,
      warnLowSpace: false,
      alertLowSpace: false,
    };

    const unprobed = await runHealthChecks({ ...base, dataDir: status });
    const unwritable = await runHealthChecks({
      ...base,
      dataDir: {
        ...status,
        checked: true,
        error: 'The data directory is not writable: /data. Likely cause: the volume is not mounted.',
      },
    });
    const ok = await runHealthChecks({
      ...base,
      dataDir: { ...status, checked: true, writable: true, volumeId: 'vol-1' },
    });

    expect(unprobed.dataDir.state).toBe('not_checked');
    expect(unprobed.dataDir.message).toMatch(/not a failure/i);
    expect(unwritable.dataDir.state).toBe('unwritable');
    expect(unwritable.dataDir.message).toMatch(/not writable/i);
    expect(ok.dataDir.state).toBe('ok');
    // Neither state changes the overall verdict — /api/health still turns on db and storage.
    expect([unprobed.ok, unwritable.ok, ok.ok]).toEqual([true, true, true]);
  });
});

describe('error tracking panel and test event', () => {
  it('shows last successful send and last confirmed Sentry receipt as two timestamps', () => {
    const panel = buildErrorTrackingPanel({
      dsnConfigured: true,
      dsnProjectId: '123456',
      environment: 'production',
      releaseSha: 'abc123',
      lastSuccessfulSendAt: '2026-08-17T12:00:00.000Z',
      lastConfirmedReceiptAt: '2026-08-17T11:00:00.000Z',
      quota: { used: 10, limit: 100, resetsAt: '2026-09-01T00:00:00.000Z' },
      dropped24h: [{ reason: 'rate_limit', count: 1 }],
      topIssues: [],
    });
    expect(panel.lastSuccessfulSendAt).toBe('2026-08-17T12:00:00.000Z');
    expect(panel.lastConfirmedReceiptAt).toBe('2026-08-17T11:00:00.000Z');
    expect(panel.lastSuccessfulSendAt).not.toBe(panel.lastConfirmedReceiptAt);
    expect(panel.status).toBe('Degraded');
  });

  it('reports received vs not within 60s against a mock Sentry API', async () => {
    const received = await sendObservabilityTestEvent({
      captureMessage: () => 'evt_test',
      flush: async () => true,
      findIssueByFingerprint: async () => ({ id: '1', lastSeen: '2026-08-17T12:00:01.000Z' }),
      sleep: async () => undefined,
      now: () => 0,
    });
    expect(received.received).toBe(true);

    let elapsed = 0;
    const missed = await sendObservabilityTestEvent({
      captureMessage: () => 'evt_test',
      flush: async () => true,
      findIssueByFingerprint: async () => null,
      sleep: async (ms) => {
        elapsed += ms;
      },
      now: () => elapsed,
    });
    expect(missed.received).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(60_000);
  });
});

describe('noise suppression', () => {
  beforeEach(() => {
    clearNoiseBuckets();
  });

  it('lets at most 10 of 50 same errors through in one minute; next allowed carries suppressed count', () => {
    const now = 1_000_000;
    const sent: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 50; i += 1) {
      const out = observabilityBeforeSend(
        {
          fingerprint: ['same-error'],
          exception: { values: [{ type: 'Error', value: 'boom' }] },
        },
        {},
        now + i * 1_000,
      );
      if (out) sent.push(out as Record<string, unknown>);
    }
    expect(sent.length).toBeLessThanOrEqual(10);
    expect(sent.length).toBe(10);

    const next = observabilityBeforeSend(
      {
        fingerprint: ['same-error'],
        exception: { values: [{ type: 'Error', value: 'boom' }] },
      },
      {},
      now + 5 * 60 * 1000 + 1,
    ) as { extra?: { suppressedCount?: number } } | null;
    expect(next).toBeTruthy();
    expect(next?.extra?.suppressedCount).toBe(40);
  });

  it('does not capture 402 or 409 as Sentry events', () => {
    expect(shouldCaptureException(Object.assign(new Error('Payment required'), { status: 402 }))).toBe(false);
    expect(shouldCaptureException(Object.assign(new Error('Conflict'), { status: 409 }))).toBe(false);
    expect(observabilityBeforeSend({ extra: { status: 402 } }, {})).toBeNull();
    expect(observabilityBeforeSend({ extra: { status: 409 } }, {})).toBeNull();
    expect(observabilityBeforeSend({ extra: { status: 404 } }, {})).toBeNull();

    const captured: unknown[] = [];
    trackFailure('paywall', Object.assign(new Error('Payment required'), { status: 402 }), { action: 'generate' }, {
      captureException: (error) => {
        captured.push(error);
      },
    });
    trackFailure('lock', Object.assign(new Error('Conflict'), { status: 409 }), { action: 'generate' }, {
      captureException: (error) => {
        captured.push(error);
      },
    });
    expect(captured).toHaveLength(0);
  });
});

describe('cron runs and staleness', () => {
  it('writes CronRun on success and on failure', async () => {
    const store = memoryStore();
    const ok = await withCronRun('check-uptime', async () => ({ ping: 'ok' }), {
      now: () => new Date('2026-08-17T12:00:00.000Z'),
      store,
    });
    expect(ok).toEqual({ ping: 'ok' });
    await expect(
      withCronRun('check-uptime', async () => {
        throw new Error('health down');
      }, {
        now: () => new Date('2026-08-17T12:01:00.000Z'),
        store,
      }),
    ).rejects.toThrow('health down');
    expect(store.crons).toHaveLength(2);
    expect(store.crons[0]).toMatchObject({ name: 'check-uptime', ok: true });
    expect(store.crons[1]).toMatchObject({ name: 'check-uptime', ok: false });
    expect(String(store.crons[1].detail)).toMatch(/health down/);
  });

  it('marks site uptime stale after 30 minutes and the daily email names it', async () => {
    expect(CRON_STALE_MS['check-uptime']).toBe(30 * 60 * 1000);
    const now = new Date('2026-08-17T12:30:00.000Z');
    const rows = evaluateSystemChecks(
      [
        {
          id: '1',
          name: 'check-uptime',
          ok: true,
          durationMs: 20,
          detail: null,
          createdAt: new Date('2026-08-17T11:59:00.000Z'),
        },
      ],
      now,
    );
    const uptime = rows.find((row) => row.name === 'check-uptime');
    expect(uptime?.stale).toBe(true);

    const emails: Array<{ text: string }> = [];
    await sendSystemChecksDigest({
      now,
      runs: [
        {
          id: '1',
          name: 'check-uptime',
          ok: true,
          durationMs: 20,
          detail: null,
          createdAt: new Date('2026-08-17T11:59:00.000Z'),
        },
      ],
      sendAdminEmail: async (mail) => {
        emails.push(mail);
      },
    });
    expect(emails[0].text).toMatch(/uptime/i);
  });
});

describe('security-class email is not dropped by workspace limit', () => {
  afterEach(() => {
    clearEmailRateLimits();
  });

  it('keeps sending security-class mail after workspace quota is exhausted', () => {
    const to = 'admin@example.com';
    for (let i = 0; i < 20; i += 1) {
      allowEmail({ to, emailClass: 'workspace' });
    }
    expect(allowEmail({ to, emailClass: 'workspace' }).allowed).toBe(false);
    expect(allowEmail({ to, emailClass: 'security' }).allowed).toBe(true);
  });

  it('sendEmail accepts emailClass without throwing', async () => {
    const result = await sendEmail({
      to: 'admin@example.com',
      subject: 'Observability',
      html: '<p>ok</p>',
      text: 'ok',
      emailClass: 'security',
    });
    expect('id' in result || ('ok' in result && result.ok === false)).toBe(true);
  });
});
