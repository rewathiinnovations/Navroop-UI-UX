import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Which boot steps are allowed to stop the server.
 *
 * `register()` runs eleven things in a row and the file used to decide, per step, whether a
 * rejection escaped — by whoever remembered to append a `.catch`. `sweepTmp()` did not have one,
 * and it is a `readdirSync` over the `/data` volume, the one resource the deployment guide warns
 * may be owned by the wrong uid: a permission error there turned best-effort cache cleanup into
 * a container that would not start (F-746). Two steps that looked equally unguarded turned out
 * to be guarded inside their own modules, where the call site could not show it — so reading the
 * file told you nothing about which failures were fatal.
 *
 * The two gates are fatal on purpose and must stay that way. `assertBackupBoot` refuses to serve
 * when the backup bucket is the asset bucket or ENCRYPTION_KEY is missing; `assertInternalOrigin`
 * refuses when NEXT_PUBLIC_APP_URL is absent or points at a different host from APP_URL in
 * production. Booting past either is worse than not booting.
 */

const boot = vi.hoisted(() => ({
  ensureDataDir: vi.fn(),
  sweepTmp: vi.fn(),
  persistVolumeIdentity: vi.fn(),
  maybeAlertLowSpace: vi.fn(),
  assertBackupBoot: vi.fn(),
  assertInternalOrigin: vi.fn(),
  wireShutdownDrain: vi.fn(),
  reconcileJobsAtBoot: vi.fn(),
  reportDatabaseInvariants: vi.fn(),
  recordCurrentRelease: vi.fn(),
  migrateEnvSentry: vi.fn(),
  reconcileRuntimeConfig: vi.fn(),
  readRuntimeConfig: vi.fn(),
  applyImmediateNoiseSettings: vi.fn(),
  runObservabilityStartup: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({ captureRequestError: vi.fn() }));
vi.mock('../../sentry.server.config', () => ({}));
vi.mock('../../sentry.edge.config', () => ({}));
vi.mock('@/lib/runtime/data-dir', () => ({
  ensureDataDir: boot.ensureDataDir,
  sweepTmp: boot.sweepTmp,
  persistVolumeIdentity: boot.persistVolumeIdentity,
  maybeAlertLowSpace: boot.maybeAlertLowSpace,
}));
vi.mock('@/lib/backup/boot', () => ({ assertBackupBoot: boot.assertBackupBoot }));
vi.mock('@/lib/api/internal-origin', () => ({ assertInternalOrigin: boot.assertInternalOrigin }));
vi.mock('@/lib/runtime/shutdown', () => ({ wireShutdownDrain: boot.wireShutdownDrain }));
vi.mock('@/lib/jobs/boot', () => ({ reconcileJobsAtBoot: boot.reconcileJobsAtBoot }));
vi.mock('@/lib/db-invariants', () => ({
  reportDatabaseInvariants: boot.reportDatabaseInvariants,
}));
vi.mock('@/lib/deploy/record', () => ({ recordCurrentRelease: boot.recordCurrentRelease }));
vi.mock('@/lib/observability/migrate-env', () => ({ migrateEnvSentry: boot.migrateEnvSentry }));
vi.mock('@/lib/observability/boot', () => ({
  reconcileRuntimeConfig: boot.reconcileRuntimeConfig,
}));
vi.mock('@/lib/observability/runtime-config', () => ({
  readRuntimeConfig: boot.readRuntimeConfig,
}));
vi.mock('@/lib/observability/noise', () => ({
  applyImmediateNoiseSettings: boot.applyImmediateNoiseSettings,
}));
vi.mock('@/lib/observability/startup', () => ({
  runObservabilityStartup: boot.runObservabilityStartup,
}));

/** Every optional step, and the last one is what proves the sequence did not stop early. */
const OPTIONAL = [
  'sweepTmp',
  'reconcileJobsAtBoot',
  'reportDatabaseInvariants',
  'recordCurrentRelease',
  'migrateEnvSentry',
  'persistVolumeIdentity',
  'reconcileRuntimeConfig',
  'maybeAlertLowSpace',
  'runObservabilityStartup',
] as const;

let runtime: string | undefined;
let warn: MockInstance<(...args: unknown[]) => void>;

async function register() {
  vi.resetModules();
  const mod = await import('../../instrumentation');
  await mod.register();
}

beforeEach(() => {
  runtime = process.env.NEXT_RUNTIME;
  process.env.NEXT_RUNTIME = 'nodejs';
  vi.clearAllMocks();
  for (const name of OPTIONAL) boot[name].mockResolvedValue(undefined);
  boot.readRuntimeConfig.mockReturnValue(null);
  boot.assertBackupBoot.mockResolvedValue(undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  if (runtime === undefined) delete process.env.NEXT_RUNTIME;
  else process.env.NEXT_RUNTIME = runtime;
  warn.mockRestore();
});

describe('register()', () => {
  it('runs every step on a healthy boot', async () => {
    await register();

    for (const name of OPTIONAL) expect(boot[name], name).toHaveBeenCalled();
    expect(boot.assertBackupBoot).toHaveBeenCalled();
    expect(boot.assertInternalOrigin).toHaveBeenCalled();
    expect(boot.wireShutdownDrain).toHaveBeenCalled();
  });

  it.each(OPTIONAL)('serves anyway when the optional step %s fails', async (failing) => {
    boot[failing].mockRejectedValue(new Error('Connection terminated unexpectedly'));

    await expect(register()).resolves.toBeUndefined();

    // Not silent: the operator has to be able to see which best-effort step was skipped.
    expect(warn.mock.calls.flat().join(' ')).toContain('optional step');
    // And the steps after it still ran — the point of the classification.
    expect(boot.runObservabilityStartup).toHaveBeenCalled();
  });

  it('serves anyway when the tmp sweep cannot read the volume', async () => {
    // The concrete case: `/data` mounted with the wrong owner, which the deployment guide
    // documents as degraded-but-running.
    boot.sweepTmp.mockImplementation(() => {
      throw Object.assign(new Error('EACCES: permission denied, scandir /data/tmp'), {
        code: 'EACCES',
      });
    });

    await expect(register()).resolves.toBeUndefined();
    expect(boot.wireShutdownDrain).toHaveBeenCalled();
  });

  it('refuses to boot when the backup gate fails', async () => {
    boot.assertBackupBoot.mockRejectedValue(new Error('BACKUP_BUCKET must differ from ELK_BUCKET'));

    await expect(register()).rejects.toThrow(/BACKUP_BUCKET/);
    // Nothing past the gate ran, so nothing wrote to the database under a broken configuration.
    expect(boot.reconcileJobsAtBoot).not.toHaveBeenCalled();
  });

  it('refuses to boot when the origin gate fails', async () => {
    boot.assertInternalOrigin.mockImplementation(() => {
      throw new Error('NEXT_PUBLIC_APP_URL is not set');
    });

    await expect(register()).rejects.toThrow(/NEXT_PUBLIC_APP_URL/);
    expect(boot.reconcileJobsAtBoot).not.toHaveBeenCalled();
  });
});
