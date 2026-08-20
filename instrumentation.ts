import * as Sentry from '@sentry/nextjs';

/**
 * Boot steps come in two kinds and which kind each one is has to be readable here.
 *
 * Required steps are deliberate fail-closed gates: a boot that gets past them without them
 * having run is worse than no boot at all, so their rejection is allowed to escape `register()`
 * and stop the server. Optional steps are best-effort maintenance and bookkeeping; a transient
 * database hiccup or a volume owned by the wrong uid must never turn one of them into a
 * container that will not start.
 *
 * The file used to make that distinction by whoever remembered a `.catch`, which left
 * `sweepTmp()` — a `readdirSync` over a volume the app may not be able to read — able to abort
 * startup, while two steps that looked unguarded were in fact guarded inside their own modules
 * where the call site could not show it (F-746).
 */
async function optional(name: string, step: () => unknown | Promise<unknown>) {
  try {
    await step();
  } catch (error) {
    console.warn(`[boot] optional step "${name}" failed; continuing without it`, error);
  }
}

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { ensureDataDir, persistVolumeIdentity, sweepTmp, maybeAlertLowSpace } =
      await import('./lib/runtime/data-dir');

    // Required. `ensureDataDir` reports an unwritable volume as a degraded status rather than
    // throwing, and the two asserts are the gates: distinct backup buckets plus a present
    // ENCRYPTION_KEY, and a NEXT_PUBLIC_APP_URL that parses and matches APP_URL. Serving with
    // either of those wrong is the failure they exist to prevent.
    ensureDataDir();
    await import('./sentry.server.config');
    const { assertBackupBoot } = await import('./lib/backup/boot');
    await assertBackupBoot();
    const { assertInternalOrigin } = await import('./lib/api/internal-origin');
    assertInternalOrigin();
    // Required, and it cannot fail: registering signal handlers touches nothing external. A
    // throw here would leave the process without a drain, which is what the handlers are for.
    const { wireShutdownDrain } = await import('./lib/runtime/shutdown');
    wireShutdownDrain();

    // Optional from here down.
    await optional('tmp sweep', sweepTmp);
    const { reconcileJobsAtBoot } = await import('./lib/jobs/boot');
    await optional('job reconcile', reconcileJobsAtBoot);
    // Optional and non-fatal, but loud: the four migration-only invariants
    // (partial indexes, the expression index, the last-admin trigger) have no
    // representation in the Prisma schema, so a schema-first rebuild of this
    // database drops them silently (F-352). Checked against the database this
    // process is actually connected to, on every boot.
    const { reportDatabaseInvariants } = await import('./lib/db-invariants');
    await optional('db invariants', reportDatabaseInvariants);
    const { recordCurrentRelease } = await import('./lib/deploy/record');
    await optional('release record', recordCurrentRelease);
    const { migrateEnvSentry } = await import('./lib/observability/migrate-env');
    await optional('sentry env migrate', migrateEnvSentry);
    await optional('volume identity persist', persistVolumeIdentity);
    const { reconcileRuntimeConfig } = await import('./lib/observability/boot');
    await optional('runtime config reconcile', reconcileRuntimeConfig);
    await optional('low-space alert', maybeAlertLowSpace);
    const { readRuntimeConfig } = await import('./lib/observability/runtime-config');
    const { applyImmediateNoiseSettings } = await import('./lib/observability/noise');
    await optional('noise settings', () => {
      // The two-state read on purpose: an unreadable file is already logged once by the
      // read itself and again by the `Sentry.init` skip, and applying no noise settings is
      // the only thing this step can do about it either way (F-738).
      const runtime = readRuntimeConfig();
      if (!runtime) return;
      applyImmediateNoiseSettings({
        ignoreList: runtime.ignoreList,
        fingerprintLimit: runtime.fingerprintLimit,
        fingerprintWindowSec: runtime.fingerprintWindowSec,
      });
    });
    const { runObservabilityStartup } = await import('./lib/observability/startup');
    await optional('observability startup check', runObservabilityStartup);
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

export const onRequestError = Sentry.captureRequestError;
