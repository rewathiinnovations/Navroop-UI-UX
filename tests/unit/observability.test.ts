import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkSiteCertificate } from '../../lib/observability/certs';
import { checkSiteUptime } from '../../lib/observability/uptime';
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
  loadSystemChecks,
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
    async listCronRuns(name: string) {
      return crons.filter((row) => row.name === name);
    },
    /** Mirrors the store's DISTINCT ON: the newest row per name, nothing truncated. */
    async listLatestCronRunPerName() {
      const latest = new Map<string, CronRunRow>();
      for (const row of crons) {
        const seen = latest.get(row.name);
        if (!seen || seen.createdAt.getTime() < row.createdAt.getTime()) latest.set(row.name, row);
      }
      return [...latest.values()];
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

  /**
   * F-632: `droppedWarning` was computed, written into the check `detail`, returned — and
   * told to nobody. `ok` was `!mismatch && !quotaWarning`, so a project actively throwing
   * errors away recorded a healthy run and emailed no one. Sentry dropping events is the
   * thing this check exists to notice.
   */
  it('alerts and fails the run when Sentry is dropping events under an unknown quota', async () => {
    const store = memoryStore();
    const emails: Array<{ subject: string; text: string }> = [];
    const result = await runObservabilityQuotaCheck({
      credentials: { authToken: 'token', orgSlug: 'navroop', projectSlug: 'app' },
      now: new Date('2026-08-17T12:00:00.000Z'),
      store,
      sentryApi: {
        getProjectStats: async () => ({
          accepted: 40,
          dropped: [{ reason: 'rate_limit', count: 17 }],
          // No per-project rate limit configured, so there is no ratio to warn about —
          // the drop is the only signal, and it used to be the one nobody heard.
          quota: { used: 40, limit: null, resetsAt: null },
          topIssues: [{ id: '1', title: 'Boom A', count: 40 }],
        }),
        findIssueByFingerprint: async () => null,
      },
      sendAdminEmail: async (mail) => {
        emails.push(mail);
      },
    });
    expect(result.droppedWarning).toBe(true);
    expect(result.quotaWarning).toBe(false);
    expect(result.ok).toBe(false);
    expect(emails).toHaveLength(1);
    expect(emails[0].text).toMatch(/rate_limit/);
    expect(emails[0].text).toMatch(/17/);
    expect(store.checks.at(-1)).toMatchObject({ kind: 'quota', ok: false });
  });

  it('does not alert on outcomes that are not drops, so the signal stays meaningful', async () => {
    const store = memoryStore();
    const emails: Array<{ subject: string }> = [];
    const result = await runObservabilityQuotaCheck({
      credentials: { authToken: 'token', orgSlug: 'navroop', projectSlug: 'app' },
      now: new Date('2026-08-17T12:00:00.000Z'),
      store,
      sentryApi: {
        getProjectStats: async () => ({
          accepted: 40,
          dropped: [{ reason: 'filtered', count: 9 }],
          quota: { used: 40, limit: null, resetsAt: null },
          topIssues: [],
        }),
        findIssueByFingerprint: async () => null,
      },
      sendAdminEmail: async (mail) => {
        emails.push(mail);
      },
    });
    expect(result.droppedWarning).toBe(false);
    expect(result.ok).toBe(true);
    expect(emails).toHaveLength(0);
  });

  /**
   * F-723: this check runs daily and had no dedupe at all — unlike `heartbeat.ts`, which
   * requires two consecutive failures — so a standing condition mailed every admin every
   * day until they filtered the sender, and by then a new alert would not be read either.
   * Mail on entering the condition; the `CronRun` row stays red for as long as it holds.
   */
  it('mails once per condition, not once per day, and again after it clears', async () => {
    const store = memoryStore();
    const emails: Array<{ subject: string }> = [];
    const run = (day: number, used: number) =>
      runObservabilityQuotaCheck({
        credentials: { authToken: 'token', orgSlug: 'navroop', projectSlug: 'app' },
        now: new Date(`2026-08-${String(day).padStart(2, '0')}T12:00:00.000Z`),
        store,
        sentryApi: {
          getProjectStats: async () => ({
            accepted: used,
            dropped: [],
            quota: { used, limit: 100, resetsAt: null },
            topIssues: [],
          }),
          findIssueByFingerprint: async () => null,
        },
        sendAdminEmail: async (mail) => {
          emails.push(mail);
        },
      });

    const first = await run(17, 85);
    expect(first.quotaWarning).toBe(true);
    expect(emails).toHaveLength(1);

    const second = await run(18, 90);
    // Still over the threshold, so the run still fails — it just does not mail again.
    expect(second.quotaWarning).toBe(true);
    expect(second.ok).toBe(false);
    expect(emails).toHaveLength(1);

    const recovered = await run(19, 10);
    expect(recovered.ok).toBe(true);
    expect(emails).toHaveLength(1);

    await run(20, 95);
    expect(emails).toHaveLength(2);
  });
});

describe('observability startup and health', () => {
  it('warns, records dsn_config false, emails, and still runs when DSN is missing in production', async () => {
    const store = memoryStore();
    const warnings: string[] = [];
    const emails: Array<{ text: string; emailClass?: string }> = [];
    // F-739 gates the email on an `AppSetting` marker. Injected here so this stays a unit
    // test: the default reads the row through Prisma.
    let marker: string | null = null;
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
      getAlerted: async () => marker,
      setAlerted: async (value) => {
        marker = value;
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
        error:
          'The data directory is not writable: /data. Likely cause: the volume is not mounted.',
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

  /**
   * F-761: the confirmation poll used to run for a full 60s inside the admin request —
   * longer than the Traefik/Coolify default, so the admin got a gateway timeout and
   * learned nothing about the event they had just sent. The wait is now capped well under
   * any proxy budget, and "sent but not yet confirmed" is reported as its own outcome
   * with the event id, instead of being indistinguishable from "did not arrive".
   */
  it('returns as soon as Sentry confirms the event', async () => {
    const received = await sendObservabilityTestEvent({
      captureMessage: () => 'evt_test',
      flush: async () => true,
      findIssueByFingerprint: async () => ({ id: '1', lastSeen: '2026-08-17T12:00:01.000Z' }),
      sleep: async () => undefined,
      now: () => 0,
    });
    expect(received.outcome).toBe('received');
    expect(received.received).toBe(true);
    expect(received.eventId).toBe('evt_test');
  });

  it('caps the in-request wait and reports sent-but-unconfirmed with the event id', async () => {
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
    expect(missed.outcome).toBe('sent_unconfirmed');
    expect(missed.received).toBe(false);
    // The admin still learns the event id, which is what makes the answer useful.
    expect(missed.eventId).toBe('evt_test');
    expect(missed.confirmError).toBeNull();
    // Polled at least once, and never held the request anywhere near a proxy timeout.
    expect(elapsed).toBeGreaterThan(0);
    expect(missed.waitedMs).toBeLessThanOrEqual(10_000);
    expect(elapsed).toBeLessThanOrEqual(10_000);
  });

  it('separates "could not ask Sentry" from "the event did not arrive"', async () => {
    const unknown = await sendObservabilityTestEvent({
      captureMessage: () => 'evt_test',
      flush: async () => true,
      findIssueByFingerprint: async () => {
        throw new Error('Sentry API HTTP 401');
      },
      sleep: async () => undefined,
      now: () => 0,
    });
    expect(unknown.outcome).toBe('sent_unconfirmed');
    expect(unknown.confirmError).toContain('401');
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
    expect(
      shouldCaptureException(Object.assign(new Error('Payment required'), { status: 402 })),
    ).toBe(false);
    expect(shouldCaptureException(Object.assign(new Error('Conflict'), { status: 409 }))).toBe(
      false,
    );
    expect(observabilityBeforeSend({ extra: { status: 402 } }, {})).toBeNull();
    expect(observabilityBeforeSend({ extra: { status: 409 } }, {})).toBeNull();
    expect(observabilityBeforeSend({ extra: { status: 404 } }, {})).toBeNull();

    const captured: unknown[] = [];
    trackFailure(
      'paywall',
      Object.assign(new Error('Payment required'), { status: 402 }),
      { action: 'generate' },
      {
        captureException: (error) => {
          captured.push(error);
        },
      },
    );
    trackFailure(
      'lock',
      Object.assign(new Error('Conflict'), { status: 409 }),
      { action: 'generate' },
      {
        captureException: (error) => {
          captured.push(error);
        },
      },
    );
    expect(captured).toHaveLength(0);
  });
});

describe('cron runs and staleness', () => {
  it('writes CronRun on success and on failure', async () => {
    const store = memoryStore();
    const ok = await withCronRun('check-uptime', async () => ({ ok: true as const, ping: 'ok' }), {
      now: () => new Date('2026-08-17T12:00:00.000Z'),
      store,
    });
    expect(ok).toEqual({ ok: true, ping: 'ok' });
    await expect(
      withCronRun(
        'check-uptime',
        async () => {
          throw new Error('health down');
        },
        {
          now: () => new Date('2026-08-17T12:01:00.000Z'),
          store,
        },
      ),
    ).rejects.toThrow('health down');
    expect(store.crons).toHaveLength(2);
    expect(store.crons[0]).toMatchObject({ name: 'check-uptime', ok: true });
    expect(store.crons[1]).toMatchObject({ name: 'check-uptime', ok: false });
    expect(String(store.crons[1].detail)).toMatch(/health down/);
  });

  /**
   * `withCronRun` used to sniff for an `ok` field and record success when it found none, so
   * every cron that aggregated per-item failures into a counter reported a healthy run.
   * `CronOutcome` makes that a compile error; these hold the runtime half of the contract.
   */
  it('does not read a run with failed items as healthy, and says which items failed', async () => {
    const store = memoryStore();
    const result = await withCronRun(
      'check-integrations',
      async () => ({
        ok: false as const,
        detail: 'GITHUB_DEPLOY: 401; CLOUDFLARE: 401',
        checked: 4,
      }),
      { now: () => new Date('2026-08-17T12:00:00.000Z'), store },
    );
    expect(result.checked).toBe(4);
    expect(store.crons).toHaveLength(1);
    expect(store.crons[0]).toMatchObject({
      name: 'check-integrations',
      ok: false,
      detail: 'GITHUB_DEPLOY: 401; CLOUDFLARE: 401',
    });
  });

  it('reads aggregated per-item errors into the receipt instead of dumping the report', async () => {
    const store = memoryStore();
    await withCronRun(
      'sweep-tmp',
      async () => ({
        ok: false as const,
        errors: ['volume identity: EACCES', 'low-space alert: SMTP down'],
        swept: 3,
      }),
      { now: () => new Date('2026-08-17T12:00:00.000Z'), store },
    );
    expect(store.crons[0].detail).toBe('volume identity: EACCES; low-space alert: SMTP down');
  });

  it('records a body that reports no outcome as failed rather than assuming success', async () => {
    // The runtime backstop for a value that arrives through an `any` — a mock, a JSON round
    // trip. Guessing success is the bug this contract exists to remove, so it guesses failure.
    const store = memoryStore();
    const untyped = async () => ({ reaped: 2 }) as unknown as { ok: boolean };
    await withCronRun('reap-jobs', untyped, {
      now: () => new Date('2026-08-17T12:00:00.000Z'),
      store,
    });
    expect(store.crons[0]).toMatchObject({ name: 'reap-jobs', ok: false });
  });

  it('keeps a healthy run readable: a success detail reaches the CronRun row', async () => {
    const store = memoryStore();
    await withCronRun(
      'check-certs',
      async () => ({
        ok: true as const,
        detail: 'certificate valid until 2026-11-01T00:00:00.000Z',
      }),
      { now: () => new Date('2026-08-17T12:00:00.000Z'), store },
    );
    expect(store.crons[0]).toMatchObject({
      ok: true,
      detail: 'certificate valid until 2026-11-01T00:00:00.000Z',
    });
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

/**
 * /admin/health and the daily digest used to read an unfiltered `listCronRuns()` whose SQL was
 * a single `LIMIT 400` across every cron name. `reap-jobs` (every minute) and `check-domains`
 * (every 2 minutes) alone write ~2160 rows a day, so the window held under three hours of
 * history while `CRON_STALE_MS` budgets `backup-db` 48 hours and `verify-storage` eight days:
 * every daily and weekly cron read as `never-run`, and every admin got a mail saying the
 * backup had never run three hours after it succeeded. Which is how an operator learns to
 * ignore the mail.
 */
describe('the system check window is per cron name', () => {
  it('still sees a backup that ran three hours behind 500 reap-jobs rows', async () => {
    const store = memoryStore();
    const now = new Date('2026-08-17T12:00:00.000Z');
    await store.createCronRun({
      name: 'backup-db',
      ok: true,
      durationMs: 9_000,
      detail: null,
      createdAt: new Date(now.getTime() - 3 * 60 * 60 * 1000),
    });
    for (let i = 0; i < 500; i += 1) {
      await store.createCronRun({
        name: 'reap-jobs',
        ok: true,
        durationMs: 1,
        detail: null,
        createdAt: new Date(now.getTime() - i * 1_000),
      });
    }

    const rows = await loadSystemChecks({ store, now });
    const backup = rows.find((row) => row.name === 'backup-db');
    expect(backup?.stale).toBe(false);
    expect(backup?.detail).not.toBe('never-run');
    expect(backup?.lastRunAt).toBe(new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString());

    // Control: the read this replaced, over the same rows. 400 newest of any name is all
    // reap-jobs, so the backup vanishes and "absent" is indistinguishable from "never ran".
    const truncated = store.crons
      .slice()
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 400);
    expect(truncated.some((row) => row.name === 'backup-db')).toBe(false);
    const oldRows = evaluateSystemChecks(truncated, now);
    expect(oldRows.find((row) => row.name === 'backup-db')?.detail).toBe('never-run');
  });

  it('does not mail admins that a fresh backup has never run', async () => {
    const store = memoryStore();
    const now = new Date('2026-08-17T12:00:00.000Z');
    for (const name of Object.keys(CRON_STALE_MS)) {
      await store.createCronRun({
        name,
        ok: true,
        durationMs: 5,
        detail: null,
        createdAt: new Date(now.getTime() - 60_000),
      });
    }
    const emails: Array<{ text: string }> = [];
    const result = await sendSystemChecksDigest({
      now,
      runs: await store.listLatestCronRunPerName(),
      sendAdminEmail: async (mail) => {
        emails.push(mail);
      },
    });
    expect(result.sent).toBe(false);
    expect(result.ok).toBe(true);
    expect(emails).toEqual([]);
  });

  it('keeps both health surfaces off the truncatable read', () => {
    // A source guard, because the failure is invisible to a fake store: `listCronRuns()` with
    // no argument used to return a global slice, and swapping either call site back would
    // reintroduce the bug with every unit test still green.
    for (const file of ['lib/observability/admin.ts', 'lib/observability/system-checks.ts']) {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      expect(source, `${file} must read the newest run per name`).toContain(
        'listLatestCronRunPerName()',
      );
      expect(source, `${file} must not read the truncatable window`).not.toMatch(
        /listCronRuns\(\s*\)/,
      );
    }
  });
});

/**
 * The two monitors whose entire output *is* the verdict, so for them `ok: false` on the
 * `CronRun` row is correct rather than alert fatigue. Both were untested, and both now owe the
 * receipt a `detail` — without one the digest line read "site uptime (check-uptime) failed"
 * with no code and no URL, and `withCronRun` fell back to dumping the whole result as JSON.
 */
describe('uptime probe', () => {
  it('reports a healthy probe with the code and the URL it used', async () => {
    const result = await checkSiteUptime({
      url: 'https://navroop.test',
      fetchFn: async () => new Response('{}', { status: 200 }),
    });
    expect(result.ok).toBe(true);
    expect(result.detail).toBe('HTTP 200 https://navroop.test/api/health');
  });

  it('fails the run on a 503 without throwing, because 503 is an answer', async () => {
    const result = await checkSiteUptime({
      url: 'https://navroop.test',
      fetchFn: async () => new Response('{}', { status: 503 }),
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('HTTP 503');
  });

  it('throws on a code that is not the app answering', async () => {
    await expect(
      checkSiteUptime({
        url: 'https://navroop.test',
        fetchFn: async () => new Response('nope', { status: 502 }),
      }),
    ).rejects.toThrow(/502/);
  });

  /**
   * F-724: Node's fetch has no default request timeout, so an origin that accepts the
   * connection and never answers hung the probe for the life of the process. `withCronRun`
   * writes its row only when the body settles, so the one monitor whose entire output is
   * the verdict went silent exactly when the site was in trouble. A hang is now a failed
   * check that names the budget.
   */
  it('passes an abort signal so a half-open origin cannot hang the probe', async () => {
    let signal: AbortSignal | null | undefined;
    await checkSiteUptime({
      url: 'https://navroop.test',
      fetchFn: async (_input, init) => {
        signal = (init as RequestInit | undefined)?.signal as AbortSignal | null | undefined;
        return new Response('{}', { status: 200 });
      },
    });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('fails the check with a timeout detail instead of hanging', async () => {
    const result = await checkSiteUptime({
      url: 'https://navroop.test',
      timeoutMs: 25,
      // A host that accepts the request and never answers: settle only when aborted.
      fetchFn: (_input, init) => {
        const { promise, reject } = Promise.withResolvers<Response>();
        const signal = (init as RequestInit | undefined)?.signal as AbortSignal | undefined;
        signal?.addEventListener('abort', () => reject(signal.reason));
        return promise;
      },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.detail).toContain('timeout after 25ms');
    expect(result.detail).toContain('https://navroop.test/api/health');
  });
});

describe('certificate check', () => {
  function fakeConnect(validTo: string) {
    return ((_options: unknown, onConnect: () => void) => {
      const socket = {
        getPeerCertificate: () => ({ valid_to: validTo }),
        end: () => undefined,
        destroy: () => undefined,
        on: () => socket,
      };
      setImmediate(onConnect);
      return socket;
    }) as unknown as typeof tls.connect;
  }

  it('fails while there is still time to renew', async () => {
    const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toUTCString();
    const result = await checkSiteCertificate({
      url: 'https://navroop.test',
      connect: fakeConnect(soon),
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('certificate expires');
  });

  it('passes on a certificate with months left, and says until when', async () => {
    const later = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toUTCString();
    const result = await checkSiteCertificate({
      url: 'https://navroop.test',
      connect: fakeConnect(later),
    });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('certificate valid until');
  });

  it('skips a non-TLS address instead of reporting a failure', async () => {
    // What an installation with no Application URL configured now looks like: `appPublicUrl`
    // falls back to localhost:3000, and a skip must not read as an expiring certificate.
    const result = await checkSiteCertificate({ url: 'http://localhost:3000' });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('certificate check skipped');
  });

  it('reports an unusable configured address as a failure, naming it', async () => {
    const result = await checkSiteCertificate({ url: 'not a url' });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('not a valid URL');
  });

  /**
   * F-740: `new Date(cert.valid_to)` on a string this Node build cannot parse gives NaN,
   * and `NaN < 14 days` is false — so the check that exists to warn before expiry
   * returned `{ ok: true, detail: 'certificate valid until Invalid Date' }` and the site
   * went down behind a green check-certs row. Absent or unreadable is never healthy.
   */
  it('does not report an unparseable expiry date as healthy', async () => {
    const result = await checkSiteCertificate({
      url: 'https://navroop.test',
      connect: fakeConnect('not-a-date'),
    });
    expect(result.ok).toBe(false);
    // The operator needs the raw string: it is what the peer actually sent.
    expect(result.detail).toContain('not-a-date');
    expect(result.detail).not.toContain('Invalid Date');
  });

  it('checks a TLS port other than 443 rather than skipping it as a pass', async () => {
    const seen: Array<{ host?: string; port?: number }> = [];
    const connect = ((options: { host?: string; port?: number }, onConnect: () => void) => {
      seen.push(options);
      const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toUTCString();
      const socket = {
        getPeerCertificate: () => ({ valid_to: soon }),
        end: () => undefined,
        destroy: () => undefined,
        on: () => socket,
      };
      setImmediate(onConnect);
      return socket;
    }) as unknown as typeof tls.connect;

    const result = await checkSiteCertificate({ url: 'https://navroop.test:8443', connect });
    expect(seen[0]?.port).toBe(8443);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('certificate expires');
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
