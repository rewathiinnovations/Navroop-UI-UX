import { getEffectiveApiKey } from '@/lib/api-keys';
import { getSettings } from '@/lib/settings/resolve';

const OVERLAY_KEYS = [
  { env: 'GEMINI_API_KEY', provider: 'google' },
  { env: 'OPENAI_API_KEY', provider: 'openai' },
  { env: 'ANTHROPIC_API_KEY', provider: 'anthropic' },
  { env: 'GROQ_API_KEY', provider: 'groq' },
  { env: 'AI_GATEWAY_API_KEY', provider: 'gateway' },
] as const;

/** Base URLs are configured in Admin → Configuration, not only in the environment. */
const OVERLAY_BASE_URLS = [
  { env: 'ANTHROPIC_BASE_URL', setting: 'ai.anthropic.baseUrl' },
  { env: 'OPENAI_BASE_URL', setting: 'ai.openai.baseUrl' },
  { env: 'GEMINI_BASE_URL', setting: 'ai.google.baseUrl' },
  { env: 'GROQ_BASE_URL', setting: 'ai.groq.baseUrl' },
  { env: 'AI_PROVIDER_CONCURRENCY', setting: 'ai.concurrency' },
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
    keys[row.env] = await getEffectiveApiKey(userId, row.provider);
  }
  const settings = await getSettings(OVERLAY_BASE_URLS.map((row) => row.setting));
  for (const row of OVERLAY_BASE_URLS) {
    keys[row.env] = settings[row.setting];
  }
  return overlayProviderKeys(env, keys);
}
