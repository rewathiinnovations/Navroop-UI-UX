export const ALL_PROVIDERS_SKIPPED_NOTE =
  'No providers were probed — all skipped (inactive, circuit cooldown, or skipProbes). Health stays unknown until a Test or a later probe.';

export const NO_PROVIDERS_CONFIGURED_NOTE =
  'No sandbox providers are configured, so none were probed. Health stays unknown until a provider is added and Tested.';

export type ProbeRow = { id: string; skipped: boolean; healthy?: boolean; error?: string };

export function summarizeProviderProbe(result: { checked?: number; results: ProbeRow[] }) {
  const skipped = result.results.filter((row) => row.skipped);
  const probed = result.results.filter((row) => !row.skipped);
  const failed = probed.filter((row) => row.healthy === false);

  if (result.results.length === 0) {
    return {
      ok: false as const,
      skipped: true as const,
      error: NO_PROVIDERS_CONFIGURED_NOTE,
      checked: 0,
      skippedCount: 0,
      failedCount: 0,
      results: result.results,
    };
  }

  if (probed.length === 0) {
    return {
      ok: false as const,
      skipped: true as const,
      error: ALL_PROVIDERS_SKIPPED_NOTE,
      checked: 0,
      skippedCount: skipped.length,
      failedCount: 0,
      results: result.results,
    };
  }

  return {
    ok: true as const,
    skipped: false as const,
    checked: probed.length,
    skippedCount: skipped.length,
    failedCount: failed.length,
    results: result.results,
  };
}
