export const API_KEY_PROVIDERS = [
  { id: 'firecrawl', label: 'Firecrawl', env: 'FIRECRAWL_API_KEY' },
  { id: 'e2b', label: 'E2B', env: 'E2B_API_KEY' },
  { id: 'openai', label: 'OpenAI', env: 'OPENAI_API_KEY' },
  { id: 'anthropic', label: 'Anthropic', env: 'ANTHROPIC_API_KEY' },
  { id: 'google', label: 'Google Gemini', env: 'GEMINI_API_KEY' },
  { id: 'groq', label: 'Groq', env: 'GROQ_API_KEY' },
  { id: 'gateway', label: 'Vercel AI Gateway', env: 'AI_GATEWAY_API_KEY' },
] as const;

export const SETTINGS_API_KEY_PROVIDERS = [
  { id: 'firecrawl', label: 'Firecrawl' },
  { id: 'e2b', label: 'E2B' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'gemini', label: 'Google Gemini' },
  { id: 'groq', label: 'Groq' },
] as const;

export type ApiKeyProvider = (typeof API_KEY_PROVIDERS)[number]['id'];
export type SettingsApiKeyProvider = (typeof SETTINGS_API_KEY_PROVIDERS)[number]['id'];

export function maskSecret(value?: string | null) {
  if (!value) return { configured: false, masked: '' };
  const last4 = value.slice(-4);
  return { configured: true, masked: `••••••••${last4}`, last4 };
}

export function last4FromSecret(value: string) {
  return value.slice(-4);
}

const PROVIDER_ALIASES: Record<string, string[]> = {
  openai: ['openai'],
  google: ['google', 'gemini'],
  gemini: ['gemini', 'google'],
  anthropic: ['anthropic'],
  groq: ['groq'],
  firecrawl: ['firecrawl'],
  e2b: ['e2b'],
  gateway: ['gateway'],
};

/** Registry keys for the providers that /admin/config manages. */
const SETTING_KEY_BY_PROVIDER: Record<string, string> = {
  openai: 'ai.openai.apiKey',
  anthropic: 'ai.anthropic.apiKey',
  google: 'ai.google.apiKey',
  gemini: 'ai.google.apiKey',
  groq: 'ai.groq.apiKey',
  gateway: 'ai.gateway.apiKey',
  firecrawl: 'tooling.firecrawl.apiKey',
  e2b: 'tooling.e2b.apiKey',
};

function envNameForProvider(id: string) {
  if (id === 'gemini') return 'GEMINI_API_KEY';
  return API_KEY_PROVIDERS.find((provider) => provider.id === id)?.env;
}

async function decodeStoredSecret(secret: string) {
  try {
    const { decrypt } = await import('./crypto');
    return decrypt(secret);
  } catch {
    return secret;
  }
}

/**
 * Personal key → org default → workspace setting → environment.
 *
 * The last two steps are the settings resolver, so a key saved in
 * Admin → Configuration is picked up by every caller that already used this
 * helper, and an untouched deployment keeps reading its environment variable.
 * Accepts settings ids (`gemini`) and provider ids (`google`).
 */
export async function getEffectiveApiKey(
  userId: string | null | undefined,
  provider: string,
): Promise<string | null> {
  const { prisma } = await import('./db');
  const aliases = PROVIDER_ALIASES[provider] ?? [provider];

  if (userId) {
    const personal = await prisma.apiKey.findFirst({
      where: { userId, provider: { in: aliases } },
      select: { secret: true },
    });
    if (personal?.secret) {
      const value = (await decodeStoredSecret(personal.secret)).trim();
      if (value) return value;
    }
  }

  const org = await prisma.orgApiKey.findFirst({
    where: { provider: { in: aliases } },
    select: { secret: true },
  });
  if (org?.secret) {
    const value = (await decodeStoredSecret(org.secret)).trim();
    if (value) return value;
  }

  const { getSetting } = await import('./settings/resolve');
  for (const id of aliases) {
    const settingKey = SETTING_KEY_BY_PROVIDER[id];
    if (settingKey) {
      const value = await getSetting(settingKey);
      if (value) return value;
    }
    // Providers with no registry entry still honour their environment variable.
    const envName = envNameForProvider(id);
    const value = envName ? process.env[envName]?.trim() : '';
    if (value) return value;
  }
  return null;
}
