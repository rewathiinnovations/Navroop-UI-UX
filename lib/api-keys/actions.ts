'use server';

import { prisma } from '@/lib/db';
import { requireAdmin, requireSessionUser } from '@/lib/auth';
import { encrypt } from '@/lib/crypto';
import { last4FromSecret, SETTINGS_API_KEY_PROVIDERS } from '@/lib/api-keys';
import { deleteApiKeySchema, parseWithZod, setApiKeySchema } from '@/lib/api-keys/schema';
import { writeAudit } from '@/lib/audit/log';

export type ActionOk<T> = { ok: true; data: T };
export type ActionErr = {
  ok: false;
  error: string;
  status: number;
  details?: unknown;
};

async function orgProviders() {
  const rows = await prisma.orgApiKey.findMany({ select: { provider: true } });
  return new Set(rows.map((row) => row.provider));
}

const OFFERED_PROVIDERS = new Set<string>(
  SETTINGS_API_KEY_PROVIDERS.map((provider) => provider.id),
);

export type ApiKeyListEntry = {
  provider: string;
  label: string;
  last4: string | null;
  hasOrgDefault?: boolean;
  /**
   * A row for a provider that is no longer offered (`deepseek`, `openai`,
   * `google`, …). It still outranks Admin → Configuration in
   * `getEffectiveApiKey`, so it must stay visible and deletable even though
   * nothing can create it any more (F-072).
   */
  legacy?: boolean;
};

export async function listPersonalApiKeys() {
  const { user, error, status } = await requireSessionUser();
  if (!user) return { ok: false as const, error, status };

  const [personal, orgSet] = await Promise.all([
    prisma.apiKey.findMany({
      where: { userId: user.id },
      select: { provider: true, last4: true },
    }),
    orgProviders(),
  ]);
  const byProvider = new Map(personal.map((row) => [row.provider, row.last4]));

  const legacy: ApiKeyListEntry[] = personal
    .filter((row) => !OFFERED_PROVIDERS.has(row.provider))
    .map((row) => ({
      provider: row.provider,
      label: row.provider,
      last4: row.last4,
      hasOrgDefault: orgSet.has(row.provider),
      legacy: true,
    }));
  const offered: ApiKeyListEntry[] = SETTINGS_API_KEY_PROVIDERS.map((provider) => ({
    provider: provider.id,
    label: provider.label,
    last4: byProvider.get(provider.id) ?? null,
    hasOrgDefault: orgSet.has(provider.id),
  }));

  return { ok: true as const, data: { keys: [...offered, ...legacy] } };
}

export async function listOrgApiKeys() {
  const { user, error, status } = await requireAdmin();
  if (!user) return { ok: false as const, error, status };

  const rows = await prisma.orgApiKey.findMany({
    select: { provider: true, last4: true },
  });
  const byProvider = new Map(rows.map((row) => [row.provider, row.last4]));

  const legacy: ApiKeyListEntry[] = rows
    .filter((row) => !OFFERED_PROVIDERS.has(row.provider))
    .map((row) => ({
      provider: row.provider,
      label: row.provider,
      last4: row.last4,
      legacy: true,
    }));
  const offered: ApiKeyListEntry[] = SETTINGS_API_KEY_PROVIDERS.map((provider) => ({
    provider: provider.id,
    label: provider.label,
    last4: byProvider.get(provider.id) ?? null,
  }));

  return { ok: true as const, data: { keys: [...offered, ...legacy] } };
}

export async function setPersonalApiKey(provider: string, secret: string) {
  const { user, error, status } = await requireSessionUser();
  if (!user) return { ok: false as const, error, status };

  const parsed = parseWithZod(setApiKeySchema, { provider, secret });
  if (!parsed.ok) return parsed;

  const last4 = last4FromSecret(parsed.data.secret);
  const existingKey = await prisma.apiKey.findUnique({
    where: { userId_provider: { userId: user.id, provider: parsed.data.provider } },
    select: { id: true },
  });
  // Encrypted at rest (F-300/F-070): only the enc:v1 ciphertext reaches the
  // row; last4 above is derived from the plaintext for display.
  const stored = encrypt(parsed.data.secret);
  await prisma.apiKey.upsert({
    where: { userId_provider: { userId: user.id, provider: parsed.data.provider } },
    create: {
      userId: user.id,
      provider: parsed.data.provider,
      secret: stored,
      last4,
    },
    update: { secret: stored, last4 },
  });

  const org = await prisma.orgApiKey.findUnique({
    where: { provider: parsed.data.provider },
    select: { id: true },
  });

  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: existingKey ? 'api_key.rotate' : 'api_key.add',
    targetType: 'api_key',
    targetId: parsed.data.provider,
    after: { provider: parsed.data.provider, changed: true },
  });

  return { ok: true as const, data: { last4, hasOrgDefault: Boolean(org) } };
}

export async function setOrgApiKey(provider: string, secret: string) {
  const { user, error, status } = await requireAdmin();
  if (!user) return { ok: false as const, error, status };

  const parsed = parseWithZod(setApiKeySchema, { provider, secret });
  if (!parsed.ok) return parsed;

  const last4 = last4FromSecret(parsed.data.secret);
  const existingKey = await prisma.orgApiKey.findUnique({
    where: { provider: parsed.data.provider },
    select: { id: true },
  });
  // Encrypted at rest (F-300/F-070), same as the personal path.
  const stored = encrypt(parsed.data.secret);
  await prisma.orgApiKey.upsert({
    where: { provider: parsed.data.provider },
    create: { provider: parsed.data.provider, secret: stored, last4 },
    update: { secret: stored, last4 },
  });

  // The more privileged mutation must leave a trail too (F-081). Never the value.
  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: existingKey ? 'api_key.rotate' : 'api_key.add',
    targetType: 'org_api_key',
    targetId: parsed.data.provider,
    after: { provider: parsed.data.provider, changed: true },
  });

  return { ok: true as const, data: { last4 } };
}

/**
 * An org row outranks Admin → Configuration for every member, so leaving one
 * unremovable let a stale credential shadow the settings page forever (F-072,
 * F-081). Admin-only, audited.
 */
export async function deleteOrgApiKey(provider: string) {
  const { user, error, status } = await requireAdmin();
  if (!user) return { ok: false as const, error, status };

  const parsed = parseWithZod(deleteApiKeySchema, { provider });
  if (!parsed.ok) return parsed;

  await prisma.orgApiKey.deleteMany({ where: { provider: parsed.data.provider } });
  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: 'api_key.delete',
    targetType: 'org_api_key',
    targetId: parsed.data.provider,
    after: { provider: parsed.data.provider, changed: true },
  });

  return { ok: true as const, data: {} };
}

export async function deleteApiKey(provider: string) {
  const { user, error, status } = await requireSessionUser();
  if (!user) return { ok: false as const, error, status };

  const parsed = parseWithZod(deleteApiKeySchema, { provider });
  if (!parsed.ok) return parsed;

  await prisma.apiKey.deleteMany({
    where: { userId: user.id, provider: parsed.data.provider },
  });
  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: 'api_key.delete',
    targetType: 'api_key',
    targetId: parsed.data.provider,
    after: { provider: parsed.data.provider, changed: true },
  });

  const org = await prisma.orgApiKey.findUnique({
    where: { provider: parsed.data.provider },
    select: { id: true },
  });

  return { ok: true as const, data: { hasOrgDefault: Boolean(org) } };
}
