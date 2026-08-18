import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  captureBootRuntimeConfig,
  readRuntimeConfig,
  resetRuntimeConfigForTests,
  writeRuntimeConfig,
} from '../../lib/observability/runtime-config';
import { runObservabilityQuotaCheck } from '../../lib/observability/quota';
import { runObservabilityStartup } from '../../lib/observability/startup';
import {
  applyImmediateNoiseSettings,
  clearNoiseBuckets,
  observabilityBeforeSend,
  resetImmediateNoiseSettings,
} from '../../lib/observability/noise';
import { migrateEnvSentry, resetSentryEnvMigrateForTests } from '../../lib/observability/migrate-env';
import { reconcileRuntimeConfig } from '../../lib/observability/boot';
import { shouldInitSentry } from '../../lib/sentry/options';
import {
  SENTRY_COPY,
  SENTRY_FIELD_HINTS,
  SENTRY_OAUTH_SCOPES,
  connectSentryWithDsn,
  sentryOAuthRedirectUrl,
  sentryRestartBanner,
  settingsChangeRequiresRestart,
  validateSentryDsn,
  verifySentryRoundTrip,
} from '../../lib/integrations/sentry';
import type { ObservabilityCheckRow, CronRunRow } from '../../lib/observability/types';

const VALID_DSN = 'https://publickey@o123.ingest.sentry.io/456789';

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

describe('sentry DSN validation', () => {
  it('returns a specific message for a malformed DSN', () => {
    const result = validateSentryDsn('not-a-dsn');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(SENTRY_COPY.malformedDsn);
  });

  it('extracts project id and host from a valid DSN', () => {
    const result = validateSentryDsn(VALID_DSN);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parsed.projectId).toBe('456789');
      expect(result.parsed.host).toBe('o123.ingest.sentry.io');
    }
  });
});

describe('sentry runtime config', () => {
  let dir: string;
  let previousPath: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'navroop-obs-'));
    previousPath = process.env.OBSERVABILITY_CONFIG_PATH;
    process.env.OBSERVABILITY_CONFIG_PATH = join(dir, 'observability.json');
    resetRuntimeConfigForTests();
  });

  afterEach(() => {
    if (previousPath === undefined) delete process.env.OBSERVABILITY_CONFIG_PATH;
    else process.env.OBSERVABILITY_CONFIG_PATH = previousPath;
    resetRuntimeConfigForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null and does not throw when the runtime file is corrupted', () => {
    writeFileSync(process.env.OBSERVABILITY_CONFIG_PATH!, '{not-json', 'utf8');
    expect(() => readRuntimeConfig()).not.toThrow();
    expect(readRuntimeConfig()).toBeNull();
  });

  it('rewrites the runtime file on boot when it differs from the Integration row', async () => {
    writeRuntimeConfig({
      enabled: true,
      dsn: VALID_DSN,
      projectId: '111',
      environment: 'production',
      tracesSampleRate: 0.1,
      sessionReplay: false,
      performance: true,
      ignoreList: [],
      fingerprintLimit: 10,
      fingerprintWindowSec: 300,
    });
    const writes: Array<{ projectId: string }> = [];
    const result = await reconcileRuntimeConfig({
      getConnected: async () => ({
        status: 'CONNECTED',
        config: {
          dsn: VALID_DSN,
          projectId: '456789',
          environment: 'production',
          tracesSampleRate: 0.2,
          orgSlug: 'navroop',
          projectSlug: 'app',
        },
      }),
      write: (config) => {
        writes.push(config);
        writeRuntimeConfig(config);
      },
    });
    expect(result.rewrote).toBe(true);
    expect(writes[0]?.projectId).toBe('456789');
    expect(readRuntimeConfig()?.projectId).toBe('456789');
  });
});

describe('sentry connect Path A', () => {
  it('connects without an auth token in the limited state', async () => {
    const result = await connectSentryWithDsn({
      dsn: VALID_DSN,
      sendVerification: async () => ({ ok: true, eventId: 'evt_1' }),
      persist: async () => undefined,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.limited).toBe(true);
      expect(result.message).toBe(SENTRY_COPY.limited);
      expect(result.restartRequired).toBe(true);
    }
  });

  it('rejects an auth token that lacks project:read and names the missing scope', async () => {
    const result = await connectSentryWithDsn({
      dsn: VALID_DSN,
      authToken: 'token-without-read',
      sendVerification: async () => ({ ok: true, eventId: 'evt_1' }),
      inspectToken: async () => ({ ok: false, missingScope: 'project:read' }),
      persist: async () => undefined,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(SENTRY_COPY.missingProjectRead);
  });

  it('shows a restart banner until the active project id matches the configured one', () => {
    const pending = sentryRestartBanner({ activeProjectId: '111', configuredProjectId: '456789' });
    expect(pending.restartRequired).toBe(true);
    expect(pending.message).toBe(SENTRY_COPY.restartRequired);
    const cleared = sentryRestartBanner({ activeProjectId: '456789', configuredProjectId: '456789' });
    expect(cleared.restartRequired).toBe(false);
  });
});

describe('sentry verification outcomes', () => {
  it('names quota when a valid DSN sends but Sentry does not receive the event', async () => {
    const result = await verifySentryRoundTrip({
      send: async () => ({ ok: true, eventId: 'evt_quota' }),
      poll: async () => null,
      getStats: async () => ({
        accepted: 0,
        dropped: [{ reason: 'quota', count: 12 }],
        quota: { used: 100, limit: 100, resetsAt: null },
        topIssues: [],
      }),
      sleep: async () => undefined,
      now: (() => {
        let t = 0;
        return () => {
          t += 60_000;
          return t;
        };
      })(),
    });
    expect(result.outcome).toBe('sent_not_received');
    expect(result.message).toMatch(/quota/i);
  });
});

describe('sentry settings apply timing', () => {
  beforeEach(() => {
    clearNoiseBuckets();
    resetImmediateNoiseSettings();
  });

  afterEach(() => {
    resetImmediateNoiseSettings();
    clearNoiseBuckets();
  });

  it('applies an ignore-list change immediately without a restart', () => {
    expect(settingsChangeRequiresRestart({ ignoreList: ['custom-noise'] })).toBe(false);
    expect(SENTRY_FIELD_HINTS.ignoreList).toMatch(/immediately/i);
    applyImmediateNoiseSettings({ ignoreList: ['custom-noise'] });
    expect(
      observabilityBeforeSend({
        exception: { values: [{ type: 'Error', value: 'custom-noise from widget' }] },
      }),
    ).toBeNull();
  });

  it('marks a sample-rate change as restart required', () => {
    expect(settingsChangeRequiresRestart({ tracesSampleRate: 0.25 })).toBe(true);
    expect(SENTRY_FIELD_HINTS.tracesSampleRate).toMatch(/restart/i);
  });
});

describe('sentry quota without auth token', () => {
  it('records skipped when there is no auth token — limited state, never a silent pass', async () => {
    const store = memoryStore();
    let apiCalls = 0;
    const result = await runObservabilityQuotaCheck({
      credentials: { authToken: '', orgSlug: 'navroop', projectSlug: 'app' },
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
});

describe('legacy SENTRY_DSN migrate-once', () => {
  afterEach(() => {
    resetSentryEnvMigrateForTests();
  });

  it('creates Sentry (migrated) once from a legacy env DSN, then ignores the env var', async () => {
    const created: Array<{ name?: string; dsn?: string }> = [];
    const first = await migrateEnvSentry({
      env: { SENTRY_DSN: VALID_DSN },
      getExisting: async () => null,
      createMigrated: async (row) => {
        created.push(row);
      },
    });
    expect(first.migrated).toBe(true);
    expect(created[0]?.name).toBe('Sentry (migrated)');
    expect(created[0]?.dsn).toBe(VALID_DSN);

    const second = await migrateEnvSentry({
      env: { SENTRY_DSN: VALID_DSN },
      getExisting: async () => ({ id: 'already' }),
      createMigrated: async (row) => {
        created.push(row);
      },
    });
    expect(second.migrated).toBe(false);
    expect(second.ignored).toBe(true);
    expect(created).toHaveLength(1);
  });
});

describe('local boot without Sentry', () => {
  it('skips Sentry init and does not warn outside production', async () => {
    const warnings: string[] = [];
    const result = await runObservabilityStartup({
      nodeEnv: 'development',
      dsn: '',
      warn: (message) => warnings.push(message),
    });
    expect(result.skipped).toBe(true);
    expect(warnings).toHaveLength(0);
    expect(shouldInitSentry({ config: null, nodeEnv: 'development' })).toBe(false);
  });
});

describe('sentry OAuth helpers', () => {
  it('exposes the exact redirect URL and required scopes', () => {
    expect(sentryOAuthRedirectUrl('https://app.navroop.app')).toBe(
      'https://app.navroop.app/api/integrations/sentry/callback',
    );
    expect(SENTRY_OAUTH_SCOPES).toEqual(['project:read', 'project:write', 'org:read', 'event:admin']);
  });
});

describe('boot snapshot vs file', () => {
  let dir: string;
  let previousPath: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'navroop-obs-boot-'));
    previousPath = process.env.OBSERVABILITY_CONFIG_PATH;
    process.env.OBSERVABILITY_CONFIG_PATH = join(dir, 'observability.json');
    resetRuntimeConfigForTests();
  });

  afterEach(() => {
    if (previousPath === undefined) delete process.env.OBSERVABILITY_CONFIG_PATH;
    else process.env.OBSERVABILITY_CONFIG_PATH = previousPath;
    resetRuntimeConfigForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the boot snapshot after the file is rewritten so the restart banner stays', () => {
    writeRuntimeConfig({
      enabled: true,
      dsn: VALID_DSN,
      projectId: '111',
      environment: 'production',
      tracesSampleRate: 0.1,
      sessionReplay: false,
      performance: true,
      ignoreList: [],
      fingerprintLimit: 10,
      fingerprintWindowSec: 300,
    });
    const boot = captureBootRuntimeConfig();
    writeRuntimeConfig({
      enabled: true,
      dsn: VALID_DSN,
      projectId: '456789',
      environment: 'production',
      tracesSampleRate: 0.1,
      sessionReplay: false,
      performance: true,
      ignoreList: [],
      fingerprintLimit: 10,
      fingerprintWindowSec: 300,
    });
    const banner = sentryRestartBanner({
      activeProjectId: boot?.projectId ?? null,
      configuredProjectId: readRuntimeConfig()?.projectId ?? null,
    });
    expect(banner.restartRequired).toBe(true);
  });
});
