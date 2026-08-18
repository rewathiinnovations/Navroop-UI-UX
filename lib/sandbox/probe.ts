/**
 * GOVERNING RULE
 * Provider health snapshots under /data/cache are reconstructible by probing again.
 * Safe to delete at any time.
 */
import { log } from '../logger';
import { writeCacheJson } from '../runtime/data-dir';
import { SandboxFactory } from './factory';
import { nextHealthAfterFailure, nextHealthAfterSuccess, shouldSkipHealthProbe } from './health';
import { listProviderConfigs, updateProviderConfig } from './store';
import { applyPreviewUrlCheck, formatProviderCheckResult, runProviderTest } from './test-run';

export async function probeProviderConfigs(now = new Date()) {
  const rows = await listProviderConfigs();
  const results: Array<{ id: string; skipped: boolean; healthy?: boolean; error?: string }> = [];

  for (const row of rows) {
    const downUntil =
      row.config.downUntil && typeof row.config.downUntil === 'string'
        ? new Date(row.config.downUntil)
        : null;
    if (
      shouldSkipHealthProbe({
        isActive: row.isActive,
        healthStatus: row.healthStatus,
        downUntil,
        now,
      }) ||
      row.config.skipProbes === true
    ) {
      results.push({ id: row.id, skipped: true });
      continue;
    }

    const provider = SandboxFactory.fromRow(row);
    const raw = await runProviderTest({
      driver: row.driver,
      secrets: {},
      providerConfigId: row.id,
      create: async () => {
        const created = await provider.createSandbox();
        return { sandboxId: created.sandboxId, previewUrl: created.url || provider.getSandboxUrl() };
      },
      runCommand: async () => provider.runCommand('echo navroop-health'),
      kill: async () => provider.terminate(),
    });
    const view = applyPreviewUrlCheck(raw, row.driver);
    const message = formatProviderCheckResult({
      driver: row.driver,
      ok: view.ok,
      failedAt: view.failedAt,
      error: view.error,
      previewUrl: view.previewUrl,
      leakedSandbox: view.leakedSandbox,
    });

    if (view.ok) {
      const healthy = nextHealthAfterSuccess();
      const config = { ...row.config };
      delete config.downUntil;
      await updateProviderConfig(row.id, {
        healthStatus: healthy.healthStatus,
        consecutiveFails: 0,
        lastCheckedAt: now,
        lastError: null,
        config,
      });
      results.push({ id: row.id, skipped: false, healthy: true });
    } else {
      const next = nextHealthAfterFailure(row.consecutiveFails, now);
      const config = { ...row.config };
      if (next.downUntil) config.downUntil = next.downUntil.toISOString();
      await updateProviderConfig(row.id, {
        healthStatus: next.healthStatus,
        consecutiveFails: next.consecutiveFails,
        lastCheckedAt: now,
        lastError: message.slice(0, 500),
        config,
      });
      results.push({ id: row.id, skipped: false, healthy: false, error: message });
    }
  }

  const summary = { checked: results.filter((row) => !row.skipped).length, results };
  // The probe result is also in the database, so a lost cache file only costs the
  // `/admin/sandbox-providers` fast path. `writeCacheJson` no longer throws, and a failure is
  // worth a line rather than an empty catch.
  const written = writeCacheJson('provider-health.json', { at: now.toISOString(), ...summary });
  if (!written.ok) {
    log.warn('sandbox.provider_health_cache_write_failed', { error: written.error });
  }
  return summary;
}
