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

export async function getStoredCoolifySettings() {
  const row = await prisma.appSetting.findUnique({
    where: { key: COOLIFY_SETTING_KEY },
    select: { value: true },
  });
  const stored = parseStored(row?.value);
  let storedToken: string | null = null;
  if (stored.tokenEncrypted) {
    try {
      storedToken = decrypt(stored.tokenEncrypted);
    } catch {
      storedToken = null;
    }
  }
  return {
    baseUrl: normalizeBaseUrl(stored.baseUrl),
    token: storedToken,
    last4: stored.last4 ?? (storedToken ? last4FromSecret(storedToken) : null),
  };
}

export async function saveStoredCoolifySettings(input: {
  baseUrl: string;
  token?: string | null;
}) {
  const existing = await getStoredCoolifySettings();
  const nextToken = input.token?.trim() ? input.token.trim() : existing.token;
  const payload: StoredCoolify = {
    baseUrl: normalizeBaseUrl(input.baseUrl),
    tokenEncrypted: nextToken ? encrypt(nextToken) : null,
    last4: nextToken ? last4FromSecret(nextToken) : null,
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

export async function getCoolifyCredentials() {
  const envToken = process.env.COOLIFY_API_TOKEN?.trim() || '';
  const envBaseUrl = process.env.COOLIFY_BASE_URL?.trim() || '';
  const stored = await getStoredCoolifySettings();
  const token = envToken || stored.token || '';
  return {
    baseUrl: normalizeBaseUrl(envBaseUrl || stored.baseUrl),
    token: token || null,
    last4: token ? last4FromSecret(token) : stored.last4,
    source: (envToken ? 'env' : stored.token ? 'stored' : 'none') as 'env' | 'stored' | 'none',
  };
}
