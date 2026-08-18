import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { ensureDataDir, persistVolumeIdentity, sweepTmp, maybeAlertLowSpace } = await import("./lib/runtime/data-dir");
    ensureDataDir();
    sweepTmp();
    await import("./sentry.server.config");
    const { assertBackupBoot } = await import("./lib/backup/boot");
    await assertBackupBoot();
    const { assertInternalOrigin } = await import("./lib/api/internal-origin");
    assertInternalOrigin();
    const { wireShutdownDrain } = await import("./lib/runtime/shutdown");
    wireShutdownDrain();
    const { reconcileJobsAtBoot } = await import("./lib/jobs/boot");
    await reconcileJobsAtBoot();
    const { recordCurrentRelease } = await import("./lib/deploy/record");
    await recordCurrentRelease();
    const { migrateEnvSandboxProvider } = await import("./lib/sandbox/migrate-env");
    await migrateEnvSandboxProvider();
    const { migrateEnvSentry } = await import("./lib/observability/migrate-env");
    await migrateEnvSentry().catch((error) => {
      console.warn("[observability] sentry env migrate failed", error);
    });
    await persistVolumeIdentity().catch((error) => {
      console.warn("[data-dir] volume identity persist failed", error);
    });
    const { reconcileRuntimeConfig } = await import("./lib/observability/boot");
    await reconcileRuntimeConfig().catch((error) => {
      console.warn("[observability] runtime config reconcile failed", error);
    });
    await maybeAlertLowSpace().catch((error) => {
      console.warn("[data-dir] low-space alert failed", error);
    });
    const { readRuntimeConfig } = await import("./lib/observability/runtime-config");
    const { applyImmediateNoiseSettings } = await import("./lib/observability/noise");
    const runtime = readRuntimeConfig();
    if (runtime) {
      applyImmediateNoiseSettings({
        ignoreList: runtime.ignoreList,
        fingerprintLimit: runtime.fingerprintLimit,
        fingerprintWindowSec: runtime.fingerprintWindowSec,
      });
    }
    const { runObservabilityStartup } = await import("./lib/observability/startup");
    await runObservabilityStartup().catch((error) => {
      console.warn("[observability] startup check failed", error);
    });
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
