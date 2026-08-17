'use server';

import { requireAdmin } from '@/lib/auth';
import { COOLIFY_DEFAULT_BASE_URL, COOLIFY_HOST } from './constants';
import { getCoolifyClient, testCoolifyApiConnection } from './client';
import { getCoolifyCredentials, saveStoredCoolifySettings } from './settings';

export type ActionOk<T> = { ok: true; data: T };
export type ActionErr = { ok: false; error: string; status: number };

function asUrl(value: string) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export async function getDeploySettings() {
  const { user, error, status } = await requireAdmin();
  if (!user) return { ok: false as const, error, status };

  const creds = await getCoolifyCredentials();
  return {
    ok: true as const,
    data: {
      baseUrl: creds.baseUrl || COOLIFY_DEFAULT_BASE_URL,
      last4: creds.last4,
      tokenSource: creds.source,
      host: COOLIFY_HOST,
      configured: Boolean(creds.token),
    },
  };
}

export async function saveDeploySettings(input: { baseUrl: string; token?: string }) {
  const { user, error, status } = await requireAdmin();
  if (!user) return { ok: false as const, error, status };

  const baseUrl = asUrl(input.baseUrl.trim());
  if (!baseUrl) {
    return { ok: false as const, error: 'Enter a valid Coolify base URL', status: 422 as const };
  }

  const token = input.token?.trim() ?? '';
  if (token && token.length < 8) {
    return { ok: false as const, error: 'API token looks too short', status: 422 as const };
  }

  const saved = await saveStoredCoolifySettings({
    baseUrl,
    token: token || null,
  });

  const creds = await getCoolifyCredentials();
  return {
    ok: true as const,
    data: {
      baseUrl: saved.baseUrl,
      last4: creds.last4,
      tokenSource: creds.source,
      host: COOLIFY_HOST,
      configured: Boolean(creds.token),
    },
  };
}

export async function testDeployConnection() {
  const { user, error, status } = await requireAdmin();
  if (!user) return { ok: false as const, error, status };

  const client = await getCoolifyClient();
  const result = await testCoolifyApiConnection();
  if (!result.ok) {
    return {
      ok: false as const,
      error: result.error,
      status: result.status || 502,
    };
  }

  return {
    ok: true as const,
    data: {
      status: result.status,
      endpoint: result.endpoint,
      version: 'version' in result ? result.version : undefined,
      last4: client?.last4 ?? null,
      source: client?.source ?? 'none',
    },
  };
}
