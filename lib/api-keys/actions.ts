'use server';

import { prisma } from '@/lib/db';
import { requireAdmin, requireSessionUser } from '@/lib/auth';
import { last4FromSecret, SETTINGS_API_KEY_PROVIDERS } from '@/lib/api-keys';
import { deleteApiKeySchema, parseWithZod, setApiKeySchema } from '@/lib/api-keys/schema';

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

  return {
    ok: true as const,
    data: {
      keys: SETTINGS_API_KEY_PROVIDERS.map((provider) => ({
        provider: provider.id,
        label: provider.label,
        last4: byProvider.get(provider.id) ?? null,
        hasOrgDefault: orgSet.has(provider.id),
      })),
    },
  };
}

export async function listOrgApiKeys() {
  const { user, error, status } = await requireAdmin();
  if (!user) return { ok: false as const, error, status };

  const rows = await prisma.orgApiKey.findMany({
    select: { provider: true, last4: true },
  });
  const byProvider = new Map(rows.map((row) => [row.provider, row.last4]));

  return {
    ok: true as const,
    data: {
      keys: SETTINGS_API_KEY_PROVIDERS.map((provider) => ({
        provider: provider.id,
        label: provider.label,
        last4: byProvider.get(provider.id) ?? null,
      })),
    },
  };
}

export async function setPersonalApiKey(provider: string, secret: string) {
  const { user, error, status } = await requireSessionUser();
  if (!user) return { ok: false as const, error, status };

  const parsed = parseWithZod(setApiKeySchema, { provider, secret });
  if (!parsed.ok) return parsed;

  const last4 = last4FromSecret(parsed.data.secret);
  await prisma.apiKey.upsert({
    where: { userId_provider: { userId: user.id, provider: parsed.data.provider } },
    create: {
      userId: user.id,
      provider: parsed.data.provider,
      secret: parsed.data.secret,
      last4,
    },
    update: { secret: parsed.data.secret, last4 },
  });

  const org = await prisma.orgApiKey.findUnique({
    where: { provider: parsed.data.provider },
    select: { id: true },
  });

  return { ok: true as const, data: { last4, hasOrgDefault: Boolean(org) } };
}

export async function setOrgApiKey(provider: string, secret: string) {
  const { user, error, status } = await requireAdmin();
  if (!user) return { ok: false as const, error, status };

  const parsed = parseWithZod(setApiKeySchema, { provider, secret });
  if (!parsed.ok) return parsed;

  const last4 = last4FromSecret(parsed.data.secret);
  await prisma.orgApiKey.upsert({
    where: { provider: parsed.data.provider },
    create: { provider: parsed.data.provider, secret: parsed.data.secret, last4 },
    update: { secret: parsed.data.secret, last4 },
  });

  return { ok: true as const, data: { last4 } };
}

export async function deleteApiKey(provider: string) {
  const { user, error, status } = await requireSessionUser();
  if (!user) return { ok: false as const, error, status };

  const parsed = parseWithZod(deleteApiKeySchema, { provider });
  if (!parsed.ok) return parsed;

  await prisma.apiKey.deleteMany({
    where: { userId: user.id, provider: parsed.data.provider },
  });

  const org = await prisma.orgApiKey.findUnique({
    where: { provider: parsed.data.provider },
    select: { id: true },
  });

  return { ok: true as const, data: { hasOrgDefault: Boolean(org) } };
}
