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

/**
 * Three distinguishable states (F-071):
 * - enc:v1 envelope, readable → the plaintext.
 * - enc:v1 envelope, undecryptable (rotated ENCRYPTION_KEY, tampered row) →
 *   null, plus an error log naming the row. Callers treat null as "no key",
 *   so the failure surfaces as provider-not-configured — never as ciphertext
 *   sent to a vendor as a bearer token.
 * - bare legacy value → decrypt if it is old-format ciphertext, otherwise
 *   accept as pre-encryption plaintext (needed until scripts/encrypt-api-keys.ts
 *   has run against the deployment).
 */
async function decodeStoredSecret(
  row: { id: string; secret: string },
  context: { provider: string; scope: 'personal' | 'org' },
): Promise<string | null> {
  const { decrypt, isEncrypted } = await import('./crypto');
  if (isEncrypted(row.secret)) {
    try {
      return decrypt(row.secret);
    } catch (error) {
      const { log } = await import('./logger');
      log.error('api_keys.secret_undecryptable', {
        provider: context.provider,
        scope: context.scope,
        rowId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
  try {
    return decrypt(row.secret);
  } catch {
    return row.secret;
  }
}

/**
 * Personal key → org default → workspace setting → environment.
 *
 * The last two steps are the settings resolver, so a key saved in
 * Admin → Configuration is picked up by every caller that already used this
 * helper, and an untouched deployment keeps reading its environment variable.
 * Accepts settings ids (`gemini`) and provider ids (`google`). The `env`
 * parameter is the same store `loadEffectiveProviderEnv` overlays onto —
 * reading `process.env` here directly ignored the env callers thread through
 * (F-078).
 */
export async function getEffectiveApiKey(
  userId: string | null | undefined,
  provider: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  const { prisma } = await import('./db');
  const aliases = PROVIDER_ALIASES[provider] ?? [provider];

  if (userId) {
    const personal = await prisma.apiKey.findFirst({
      where: { userId, provider: { in: aliases } },
      select: { id: true, secret: true },
    });
    if (personal?.secret) {
      const value = (await decodeStoredSecret(personal, { provider, scope: 'personal' }))?.trim();
      if (value) return value;
    }
  }

  const org = await prisma.orgApiKey.findFirst({
    where: { provider: { in: aliases } },
    select: { id: true, secret: true },
  });
  if (org?.secret) {
    const value = (await decodeStoredSecret(org, { provider, scope: 'org' }))?.trim();
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
    const value = envName ? env[envName]?.trim() : '';
    if (value) return value;
  }
  return null;
}
