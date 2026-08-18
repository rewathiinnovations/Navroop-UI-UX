import { getEffectiveApiKey } from '@/lib/api-keys';

const OVERLAY_KEYS = [
  { env: 'GEMINI_API_KEY', provider: 'google' },
  { env: 'OPENAI_API_KEY', provider: 'openai' },
  { env: 'ANTHROPIC_API_KEY', provider: 'anthropic' },
  { env: 'GROQ_API_KEY', provider: 'groq' },
  { env: 'AI_GATEWAY_API_KEY', provider: 'gateway' },
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
  return overlayProviderKeys(env, keys);
}
