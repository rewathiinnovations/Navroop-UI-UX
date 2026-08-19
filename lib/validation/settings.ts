import { prisma } from '@/lib/db';

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
 * costs credits and wall-clock time. With it off the user is still told exactly
 * what is broken and the job still records the failure — see
 * `decideAutoFix({ enabled: false })`.
 *
 * Follows lib/memory/settings.ts: an AppSetting row read defensively, never
 * throwing into the generation path.
 */

export const BUILD_AUTOFIX_SETTING_KEY = 'buildAutoFixEnabled';

function parseEnabled(value: string | null | undefined) {
  if (value == null) return true;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'false' || normalized === '0' || normalized === 'off') return false;
  return true;
}

export async function getBuildAutoFixEnabled() {
  try {
    const row = await prisma.appSetting.findUnique({
      where: { key: BUILD_AUTOFIX_SETTING_KEY },
      select: { value: true },
    });
    return parseEnabled(row?.value);
  } catch (error) {
    // A settings read must never break an apply. Fall back to the default.
    console.warn('[validation] failed to read build auto-fix setting', error);
    return true;
  }
}

export async function setBuildAutoFixEnabled(enabled: boolean) {
  await prisma.appSetting.upsert({
    where: { key: BUILD_AUTOFIX_SETTING_KEY },
    create: { key: BUILD_AUTOFIX_SETTING_KEY, value: enabled ? 'true' : 'false' },
    update: { value: enabled ? 'true' : 'false' },
  });
  return enabled;
}
