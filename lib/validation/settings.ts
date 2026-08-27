import { getSetting } from '@/lib/settings/resolve';

/**
 * Admin toggle for the post-generation auto-fix loop.
 *
 * It governs the *fix*, never the check. Both checks now run unconditionally —
 * the static import scan is free, and the esbuild compile is in-process — because
 * the earlier arrangement is what let a broken build reach a user: the check
 * shelled a build command into a sandbox, the sandbox subsystem was deleted, and
 * every run silently "skipped". A check that can be switched off invisibly is the
 * same hole with a different cause.
 *
 * What this setting decides is whether a failure earns another generation, which
 * is a fresh POST to /api/generate-ai-code-stream and therefore a fresh credit
 * charge. With it off the user is still told exactly what is broken and the job
 * still records the failure — see `decideAutoFix({ enabled: false })`.
 *
 * It resolves through `lib/settings/resolve.ts` — the same DB → env → fallback
 * path every other operator-facing value uses — rather than reading a bare
 * `AppSetting` row of its own. The bare row was the bug: this file owned both a
 * reader and a writer for the key `buildAutoFixEnabled`, the writer had no caller
 * anywhere in `app/`, `lib/`, `components/` or `scripts/`, and the key was absent
 * from `lib/settings/registry.ts`, so /admin/config could not see it either. An
 * unbounded, billed repair loop defaulted to on with no switch an operator could
 * reach. Going through the registry is what makes /admin/config the writer, and
 * the write lands on the row this read looks at because both name the same
 * registry key.
 */

/**
 * Registry key, so the row this reads is the row /admin/config writes. Renaming
 * it without renaming the registry entry silently reinstates the split that made
 * the toggle unreachable.
 */
export const BUILD_AUTOFIX_SETTING_KEY = 'generation.buildAutoFix';

/**
 * Anything but an explicit "off" means on. The registry writes `on` / `off`, but
 * an operator who typed `false` or `0` into the row by hand meant the same thing,
 * and reading that as "on" would spend credits they were trying to stop.
 */
export function parseBuildAutoFixEnabled(value: string | null | undefined) {
  if (value == null) return true;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  return !['off', 'false', '0', 'no', 'disabled'].includes(normalized);
}

export async function getBuildAutoFixEnabled() {
  try {
    return parseBuildAutoFixEnabled(await getSetting(BUILD_AUTOFIX_SETTING_KEY));
  } catch (error) {
    // A settings read must never break an apply. Fall back to the default.
    console.warn('[validation] failed to read build auto-fix setting', error);
    return true;
  }
}
