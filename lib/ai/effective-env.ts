import { getEffectiveApiKey } from '@/lib/api-keys';
import { getSettings } from '@/lib/settings/resolve';

export const OVERLAY_KEYS = [{ env: 'DEEPSEEK_API_KEY', provider: 'deepseek' }] as const;

/** Non-secret AI settings configured in Admin → Configuration, not only in the environment. */
const OVERLAY_BASE_URLS = [
  { env: 'DEEPSEEK_BASE_URL', setting: 'ai.deepseek.baseUrl' },
  { env: 'AI_PROVIDER_CONCURRENCY', setting: 'ai.concurrency' },
  { env: 'AI_PRIMARY_MODEL', setting: 'ai.primaryModel' },
] as const;

/**
 * Admin / personal keys win over a blank env slot. Generation reads this
 * overlay — not process.env alone — so a key saved on /settings is usable.
 */
export function overlayProviderKeys(
  env: Record<string, string | undefined>,
  keys: Partial<Record<string, string | null>>,
): Record<string, string | undefined> {
  const next = { ...env };
  for (const [name, value] of Object.entries(keys)) {
    if (value?.trim()) next[name] = value.trim();
  }
  return next;
}

export async function loadEffectiveProviderEnv(
  userId: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): Promise<Record<string, string | undefined>> {
  const keys: Record<string, string | null> = {};
  for (const row of OVERLAY_KEYS) {
    keys[row.env] = await getEffectiveApiKey(userId, row.provider, env);
  }
  const settings = await getSettings(OVERLAY_BASE_URLS.map((row) => row.setting));
  for (const row of OVERLAY_BASE_URLS) {
    keys[row.env] = settings[row.setting];
  }
  return overlayProviderKeys(env, keys);
}
