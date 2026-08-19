/**
 * Keys a person can set for themselves.
 *
 * Firecrawl is the only one left: E2B went with the sandboxes, and generation
 * runs on DeepSeek with one workspace-wide key set in Admin → Configuration,
 * not a per-user one. Listing the others invited people to paste keys that
 * nothing would ever read.
 */
export const SETTINGS_API_KEY_PROVIDERS = [{ id: 'firecrawl', label: 'Firecrawl' }] as const;

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
  deepseek: ['deepseek'],
  openai: ['openai'],
  google: ['google', 'gemini'],
  gemini: ['gemini', 'google'],
  firecrawl: ['firecrawl'],
};

/**
 * Registry keys for the providers that /admin/config manages.
 *
 * `deepseek` has to be here. Without it a key saved in Admin → Configuration
 * resolved to null, the overlay left DEEPSEEK_API_KEY at whatever the
 * environment had, and generation kept reporting "DeepSeek is not configured"
 * — while pointing the admin at the page they had just used.
 */
const SETTING_KEY_BY_PROVIDER: Record<string, string> = {
  deepseek: 'ai.deepseek.apiKey',
  openai: 'ai.openai.apiKey',
  google: 'ai.google.apiKey',
  gemini: 'ai.google.apiKey',
  firecrawl: 'tooling.firecrawl.apiKey',
};

/** Environment variable each provider falls back to. */
const ENV_BY_PROVIDER: Record<string, string> = {
  deepseek: 'DEEPSEEK_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  firecrawl: 'FIRECRAWL_API_KEY',
};

function envNameForProvider(id: string) {
  return ENV_BY_PROVIDER[id];
}

/** The Admin → Configuration setting a provider's key is stored under. */
export function settingKeyForProvider(id: string): string | undefined {
  return SETTING_KEY_BY_PROVIDER[id];
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
