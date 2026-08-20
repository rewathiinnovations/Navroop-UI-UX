/**
 * Boot-time observability signalling: the two ways it used to go wrong quietly.
 *
 * F-738 — an unreadable `observability.json` made `buildSentryInitOptions` return null and
 * `Sentry.init` never ran. Nothing at the init decision said so, so the process was blind
 * for its whole life and the only visible state was indistinguishable from "Sentry was
 * never connected".
 *
 * F-739 — with no DSN in production, `runObservabilityStartup` emailed every admin on every
 * boot. Observability mail is `emailClass: 'security'` and therefore exempt from the
 * per-recipient rate-limit bucket, so a crash-looping container mailed every admin every
 * few seconds about a configuration state that had not changed.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendObservabilityAdminEmail } from '../../lib/observability/alerts';
import { reconcileRuntimeConfig } from '../../lib/observability/boot';
import {
  getBootRuntimeConfigState,
  captureBootRuntimeConfig,
  resetRuntimeConfigForTests,
  writeRuntimeConfig,
} from '../../lib/observability/runtime-config';
import { runObservabilityStartup } from '../../lib/observability/startup';
import { buildSentryInitOptions, describeSentryInit } from '../../lib/sentry/options';
import { runHealthChecks } from '../../lib/health/check';
import type { ObservabilityCheckRow, ObservabilityEmail } from '../../lib/observability/types';

const VALID_DSN = 'https://publickey@o123.ingest.sentry.io/456789';

function checkStore() {
  const checks: Array<Omit<ObservabilityCheckRow, 'id'>> = [];
  return {
    checks,
    async createCheck(row: Omit<ObservabilityCheckRow, 'id'>) {
      checks.push(row);
      return { id: `chk_${checks.length}`, ...row } as ObservabilityCheckRow;
    },
  };
}

/** The `AppSetting` row `runObservabilityStartup` uses to remember it already alerted. */
function markerStore(initial: string | null = null) {
  let value = initial;
  return {
    reads: 0,
    writes: [] as Array<string | null>,
    getAlerted: async function (this: { reads: number }) {
      this.reads += 1;
      return value;
    },
    setAlerted: async function (this: { writes: Array<string | null> }, next: string | null) {
      this.writes.push(next);
      value = next;
    },
  };
}

describe('observability startup dsn alert (F-739)', () => {
  it('emails the admins once per release, not once per boot', async () => {
    const sent: ObservabilityEmail[] = [];
    const marker = markerStore();
    const deps = {
      nodeEnv: 'production',
      dsn: '',
      environment: 'production',
      releaseSha: 'sha-aaa',
      store: checkStore(),
      warn: () => undefined,
      sendAdminEmail: async (mail: ObservabilityEmail) => {
        sent.push(mail);
      },
      getAlerted: marker.getAlerted.bind(marker),
      setAlerted: marker.setAlerted.bind(marker),
    };

    const first = await runObservabilityStartup(deps);
    expect(first.alerted).toBe(true);
    expect(sent).toHaveLength(1);

    // A crash loop is the same release restarting. The check row is still written every
    // boot — that is the health signal — but the mailbox is left alone.
    const second = await runObservabilityStartup({ ...deps, store: checkStore() });
    expect(second.alerted).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it('still writes the dsn_config check row on the suppressed boot', async () => {
    const marker = markerStore('missing_dsn:sha-aaa');
    const store = checkStore();
    await runObservabilityStartup({
      nodeEnv: 'production',
      dsn: '',
      releaseSha: 'sha-aaa',
      store,
      warn: () => undefined,
      sendAdminEmail: async () => undefined,
      getAlerted: marker.getAlerted.bind(marker),
      setAlerted: marker.setAlerted.bind(marker),
    });
    expect(store.checks).toHaveLength(1);
    expect(store.checks[0]?.ok).toBe(false);
  });

  it('alerts again on a new release', async () => {
    const sent: ObservabilityEmail[] = [];
    const marker = markerStore('missing_dsn:sha-aaa');
    await runObservabilityStartup({
      nodeEnv: 'production',
      dsn: '',
      releaseSha: 'sha-bbb',
      store: checkStore(),
      warn: () => undefined,
      sendAdminEmail: async (mail: ObservabilityEmail) => {
        sent.push(mail);
      },
      getAlerted: marker.getAlerted.bind(marker),
      setAlerted: marker.setAlerted.bind(marker),
    });
    expect(sent).toHaveLength(1);
    expect(marker.writes).toEqual(['missing_dsn:sha-bbb']);
  });

  it('clears the marker once a DSN is configured, so a later break alerts again', async () => {
    const marker = markerStore('missing_dsn:sha-aaa');
    const result = await runObservabilityStartup({
      nodeEnv: 'production',
      dsn: VALID_DSN,
      releaseSha: 'sha-aaa',
      store: checkStore(),
      warn: () => undefined,
      sendAdminEmail: async () => undefined,
      getAlerted: marker.getAlerted.bind(marker),
      setAlerted: marker.setAlerted.bind(marker),
    });
    expect(result.dsnConfigured).toBe(true);
    expect(marker.writes).toEqual([null]);
  });

  it('does not swallow a marker read failure into a silent send', async () => {
    const sent: ObservabilityEmail[] = [];
    const logged: string[] = [];
    const spy = vi
      .spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => logged.push(String(args[0] ?? '')));
    const result = await runObservabilityStartup({
      nodeEnv: 'production',
      dsn: '',
      releaseSha: 'sha-aaa',
      store: checkStore(),
      warn: () => undefined,
      sendAdminEmail: async (mail: ObservabilityEmail) => {
        sent.push(mail);
      },
      getAlerted: async () => {
        throw new Error('database is down');
      },
      setAlerted: async () => undefined,
    });
    spy.mockRestore();
    // The admin address list comes from the same database, so a marker read that fails is
    // a database that could not have delivered the mail either. Reported, not hidden.
    expect(sent).toHaveLength(0);
    expect(result.alerted).toBe(false);
    expect(result.alertMarkerError).toContain('database is down');
    expect(logged.join('\n')).toContain('observability.dsn_alert_marker_unreadable');
  });
});

describe('observability admin email fan-out (F-739)', () => {
  it('reports the recipients whose send failed instead of discarding the result', async () => {
    const attempted: string[] = [];
    const result = await sendObservabilityAdminEmail(
      { subject: 'Sentry is not connected', html: '<p>x</p>', text: 'x' },
      {
        listAdminEmails: async () => ['a@example.com', 'bad@example.com', 'c@example.com'],
        send: async ({ to }) => {
          attempted.push(to);
          // `SendEmailResult` success arm is `{ id }`; the failure arm carries `ok: false`.
          return to === 'bad@example.com'
            ? { ok: false as const, error: 'mailbox unavailable' }
            : { id: 'msg_1' };
        },
      },
    );
    // Every admin is attempted: one bad address must not decide who else hears about it.
    expect(attempted).toHaveLength(3);
    expect(result.sent).toBe(2);
    expect(result.failed).toEqual(['bad@example.com']);
  });

  it('counts a thrown send as a failure rather than losing the whole fan-out', async () => {
    const result = await sendObservabilityAdminEmail(
      { subject: 's', html: 'h', text: 't' },
      {
        listAdminEmails: async () => ['a@example.com', 'b@example.com'],
        send: async ({ to }) => {
          if (to === 'a@example.com') throw new Error('transport exploded');
          return { id: 'msg_2' };
        },
      },
    );
    expect(result.sent).toBe(1);
    expect(result.failed).toEqual(['a@example.com']);
  });
});

describe('runtime config reconcile distinguishes unreadable from absent (F-738)', () => {
  const CONNECTED = {
    status: 'CONNECTED',
    config: { dsn: VALID_DSN, projectId: '456789', environment: 'production' },
  };

  it('reports that it repaired a file it could not read', async () => {
    const written: string[] = [];
    const result = await reconcileRuntimeConfig({
      getConnected: async () => CONNECTED,
      read: () => ({ state: 'unreadable', message: 'EACCES: permission denied', code: 'EACCES' }),
      write: (config) => written.push(config.projectId),
    });
    expect(result.rewrote).toBe(true);
    expect(result.unreadable).toBe(true);
    expect(written).toEqual(['456789']);
  });

  it('does not claim a repair when the file was simply absent', async () => {
    const result = await reconcileRuntimeConfig({
      getConnected: async () => CONNECTED,
      read: () => ({ state: 'absent' }),
      write: () => undefined,
    });
    expect(result.rewrote).toBe(true);
    expect(result.unreadable).toBe(false);
  });

  it('leaves a matching readable file alone', async () => {
    const config = {
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
    };
    const writes: string[] = [];
    const result = await reconcileRuntimeConfig({
      getConnected: async () => CONNECTED,
      read: () => ({ state: 'ok' as const, config }),
      write: (next) => writes.push(next.projectId),
    });
    expect(result.rewrote).toBe(false);
    expect(writes).toEqual([]);
  });

  it('rewrites for a region change alone', async () => {
    // `writeRuntimeConfig` persists `region`, and `runtimeConfigDiffers` left it out of
    // the comparison — so an org moved to another Sentry region kept the stale value
    // forever and every API call kept going to the wrong host (F-738).
    const onDisk = {
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
      region: 'us',
    };
    const writes: Array<string | undefined> = [];
    const result = await reconcileRuntimeConfig({
      getConnected: async () => ({ ...CONNECTED, config: { ...CONNECTED.config, region: 'de' } }),
      read: () => ({ state: 'ok' as const, config: onDisk }),
      write: (next) => writes.push(next.region),
    });
    expect(result.rewrote).toBe(true);
    expect(writes).toEqual(['de']);
  });
});

describe('sentry init skip is not silent (F-738)', () => {
  let dir: string;
  let previousPath: string | undefined;
  let errors: unknown[][];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'navroop-obs-boot-'));
    previousPath = process.env.OBSERVABILITY_CONFIG_PATH;
    process.env.OBSERVABILITY_CONFIG_PATH = join(dir, 'observability.json');
    resetRuntimeConfigForTests();
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousPath === undefined) delete process.env.OBSERVABILITY_CONFIG_PATH;
    else process.env.OBSERVABILITY_CONFIG_PATH = previousPath;
    resetRuntimeConfigForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  function loggedEvents() {
    return errors.map((args) => String(args[0] ?? '')).join('\n');
  }

  it('remembers that the boot read failed, not merely that there was no config', () => {
    writeFileSync(process.env.OBSERVABILITY_CONFIG_PATH!, '{not-json', 'utf8');
    expect(buildSentryInitOptions()).toBeNull();
    expect(getBootRuntimeConfigState()?.state).toBe('unreadable');
    expect(loggedEvents()).toContain('sentry.init_skipped_unreadable_config');
  });

  it('reports the blind process on /api/health even after the file is repaired', async () => {
    writeFileSync(process.env.OBSERVABILITY_CONFIG_PATH!, '{not-json', 'utf8');
    expect(buildSentryInitOptions()).toBeNull();
    // The operator fixes the file; nothing re-runs `Sentry.init` in this process.
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
    const health = await runHealthChecks({
      db: { $queryRaw: async () => [1] },
      storageHead: async () => true,
    });
    // The live DSN read is green, which is exactly what made this invisible.
    expect(health.sentry.dsnConfigured).toBe(true);
    expect(health.observabilityFile.state).toBe('ok');
    expect(health.sentry.initState).toBe('skipped_unreadable');
  });

  it('reports an initialised process when the boot read carried a DSN', async () => {
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
    expect(buildSentryInitOptions()).not.toBeNull();
    const health = await runHealthChecks({
      db: { $queryRaw: async () => [1] },
      storageHead: async () => true,
    });
    expect(health.sentry.initState).toBe('initialised');
  });

  it('claims nothing when no boot read happened in this process', () => {
    expect(describeSentryInit(null)).toBe('not_captured');
    expect(describeSentryInit({ state: 'absent' })).toBe('skipped_absent');
  });

  it('says nothing extra when there simply is no config file', () => {
    expect(buildSentryInitOptions()).toBeNull();
    expect(getBootRuntimeConfigState()?.state).toBe('absent');
    expect(loggedEvents()).not.toContain('sentry.init_skipped_unreadable_config');
  });

  it('still initialises from a readable enabled config', () => {
    writeRuntimeConfig({
      enabled: true,
      dsn: VALID_DSN,
      projectId: '456789',
      environment: 'production',
      tracesSampleRate: 0.2,
      sessionReplay: false,
      performance: true,
      ignoreList: [],
      fingerprintLimit: 10,
      fingerprintWindowSec: 300,
    });
    const options = buildSentryInitOptions();
    expect(options?.dsn).toBe(VALID_DSN);
    expect(getBootRuntimeConfigState()?.state).toBe('ok');
    // The two-state accessor keeps working for the callers that only want the config.
    expect(captureBootRuntimeConfig()?.projectId).toBe('456789');
    expect(loggedEvents()).not.toContain('sentry.init_skipped_unreadable_config');
  });
});

/**
 * F-762. The plugin options `withSentryConfig` consumes are not observable on the object
 * it returns, so the org/project half is asserted against the source text; the half that
 * can be executed — that the file still loads and still produces the Next config the
 * Docker image depends on — is asserted by importing it.
 */
describe('next.config.ts sentry build options (F-762)', () => {
  // Comments stripped: the assertions are about what the build does, and the file
  // deliberately names the removed literals in prose so the reason survives.
  const source = readFileSync(join(import.meta.dirname, '..', '..', 'next.config.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('takes the sentry org and project from the environment', () => {
    expect(source).toContain('SENTRY_ORG');
    expect(source).toContain('SENTRY_PROJECT');
    // The two literals that used to point every operator's release artefacts at one org.
    expect(source).not.toContain("'rewathi'");
    expect(source).not.toContain("'navroop-nextjs'");
  });

  it('skips source-map upload rather than failing the build when they are unset', () => {
    expect(source).toMatch(/sourcemaps:\s*\{\s*disable:/);
  });

  it('carries no vercel cron instrumentation', () => {
    // Vercel-only, webpack-only, and excluded from App Router route handlers by its own
    // docs. It was set to `true` and did nothing.
    expect(source).not.toContain('automaticVercelMonitors');
  });

  it('still produces the next config the image is built against', async () => {
    const config = (await import('../../next.config')).default;
    expect(config.output).toBe('standalone');
    expect(config.serverExternalPackages).toContain('lighthouse');
    expect(config.serverExternalPackages).toContain('esbuild');
    expect(config.outputFileTracingIncludes?.['/*']).toContain('./generated/prisma/**/*');
  });
});
