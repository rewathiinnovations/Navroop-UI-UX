import { prisma } from '@/lib/db';

/**
 * Admin toggle for post-apply build validation and the auto-fix loop.
 *
 * This is a setting rather than always-on because validation runs the stack's
 * real build command after every apply. That is the only signal that generalizes
 * across stacks, but it costs wall-clock time and metered sandbox minutes on
 * every edit — including a one-word copy change. Enabled by default (a site that
 * does not compile is worse than one that took longer to produce), off in one
 * click when that trade is wrong for a workspace.
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
