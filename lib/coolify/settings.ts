import { decrypt, encrypt } from '@/lib/crypto';
import { prisma } from '@/lib/db';
import { last4FromSecret } from '@/lib/api-keys';
import { COOLIFY_DEFAULT_BASE_URL, COOLIFY_SETTING_KEY } from './constants';

type StoredCoolify = {
  baseUrl?: string;
  tokenEncrypted?: string | null;
  last4?: string | null;
};

function normalizeBaseUrl(value: string | null | undefined) {
  const trimmed = value?.trim().replace(/\/+$/, '') ?? '';
  return trimmed || COOLIFY_DEFAULT_BASE_URL;
}

function parseStored(raw: string | null | undefined): StoredCoolify {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as StoredCoolify;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The legacy `AppSetting` Coolify row.
 *
 * `tokenUnreadable` is the distinction that matters on the write path: a token is absent when
 * the row never held one, and *unreadable* when the stored ciphertext will not decrypt (a
 * rotated `ENCRYPTION_KEY`). Both surfaced as `token: null`, and the save below treated that
 * as permission to write `tokenEncrypted: null` — so one base-URL edit destroyed a credential
 * over what was only a key problem (F-252).
 */
export async function getStoredCoolifySettings() {
  const row = await prisma.appSetting.findUnique({
    where: { key: COOLIFY_SETTING_KEY },
    select: { value: true },
  });
  const stored = parseStored(row?.value);
  let storedToken: string | null = null;
  let tokenUnreadable = false;
  if (stored.tokenEncrypted) {
    try {
      storedToken = decrypt(stored.tokenEncrypted);
    } catch {
      storedToken = null;
      tokenUnreadable = true;
    }
  }
  return {
    baseUrl: normalizeBaseUrl(stored.baseUrl),
    token: storedToken,
    last4: stored.last4 ?? (storedToken ? last4FromSecret(storedToken) : null),
    tokenUnreadable,
    /** The ciphertext as stored, so a save that is not changing the token can carry it over. */
    tokenEncrypted: stored.tokenEncrypted ?? null,
  };
}

export async function saveStoredCoolifySettings(input: { baseUrl: string; token?: string | null }) {
  const existing = await getStoredCoolifySettings();
  const nextToken = input.token?.trim() ? input.token.trim() : null;
  // A save that supplies no token must leave the stored one exactly as it is — including
  // when it could not be decrypted. That is a key problem to fix, not an instruction to
  // delete the credential.
  const payload: StoredCoolify = nextToken
    ? {
        baseUrl: normalizeBaseUrl(input.baseUrl),
        tokenEncrypted: encrypt(nextToken),
        last4: last4FromSecret(nextToken),
      }
    : {
        baseUrl: normalizeBaseUrl(input.baseUrl),
        tokenEncrypted: existing.tokenEncrypted,
        last4: existing.last4,
      };
  await prisma.appSetting.upsert({
    where: { key: COOLIFY_SETTING_KEY },
    create: { key: COOLIFY_SETTING_KEY, value: JSON.stringify(payload) },
    update: { value: JSON.stringify(payload) },
  });
  return {
    baseUrl: payload.baseUrl ?? COOLIFY_DEFAULT_BASE_URL,
    last4: payload.last4 ?? null,
  };
}

/**
 * Where the Coolify credentials came from. `'env'` used to be in this union and was
 * unreachable — nothing reads a Coolify token from the environment (`client.ts`) — so every
 * branch on it in the admin surface was dead code (F-252).
 */
export type CoolifyCredentialSource = 'stored' | 'none';

export type CoolifyCredentials = {
  baseUrl: string;
  token: string | null;
  last4: string | null;
  source: CoolifyCredentialSource;
};

export async function getCoolifyCredentials(): Promise<CoolifyCredentials> {
  const { getIntegration } = await import('@/lib/integrations/store');
  const connected = await getIntegration('default', 'COOLIFY');
  if (connected?.status === 'CONNECTED' && connected.secrets.token && connected.config.baseUrl) {
    const token = connected.secrets.token;
    return {
      baseUrl: normalizeBaseUrl(connected.config.baseUrl),
      token,
      last4: last4FromSecret(token),
      source: 'stored',
    };
  }
  const stored = await getStoredCoolifySettings();
  return {
    baseUrl: normalizeBaseUrl(stored.baseUrl),
    token: stored.token || null,
    last4: stored.token ? last4FromSecret(stored.token) : stored.last4,
    source: stored.token ? 'stored' : 'none',
  };
}
