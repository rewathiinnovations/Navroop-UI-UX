import { asCloudflareZones, chooseCloudflareZone, cloudflarePermissionMessage } from './cloudflare';
import type { CloudflareZone } from './types';
import { upsertIntegration } from './store';
import { DEFAULT_WORKSPACE_ID } from '@/lib/publish/constants';

const API = 'https://api.cloudflare.com/client/v4';

type CfBody<T> = {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: T;
};

async function cf<T>(token: string, path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: CfBody<T> }> {
  // Trusted host — do not route through safeFetch.
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const body = ((await response.json().catch(() => null)) as CfBody<T> | null) ?? {};
  return { ok: response.ok && body.success !== false, status: response.status, body };
}

export async function verifyCloudflareToken(token: string) {
  const result = await cf<{ status?: string }>(token, '/user/tokens/verify');
  if (!result.ok) {
    return {
      ok: false as const,
      error:
        cloudflarePermissionMessage({ errors: result.body.errors, status: result.status }) ||
        result.body.errors?.[0]?.message ||
        'Cloudflare token is invalid',
    };
  }
  return { ok: true as const };
}

export async function listCloudflareZones(token: string) {
  const result = await cf<unknown>(token, '/zones?per_page=50');
  if (!result.ok) {
    return {
      ok: false as const,
      error:
        cloudflarePermissionMessage({
          errors: result.body.errors?.map((row) => ({
            ...row,
            message: row.message || 'Unable to authenticate request to list zones',
          })),
          status: result.status,
        }) || 'Zone → Zone → Read permission missing',
    };
  }
  return { ok: true as const, zones: asCloudflareZones(result.body.result) };
}

export async function probeCloudflareDnsEdit(token: string, zoneId: string, zoneName: string) {
  const name = `_navroop-check.${zoneName}`;
  const created = await cf<{ id?: string }>(token, `/zones/${zoneId}/dns_records`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'TXT',
      name,
      content: 'navroop-permission-check',
      ttl: 120,
    }),
  });
  if (!created.ok) {
    return {
      ok: false as const,
      error:
        cloudflarePermissionMessage({ errors: created.body.errors, status: created.status }) ||
        'Zone → DNS → Edit permission missing',
    };
  }
  const id = created.body.result?.id;
  if (id) {
    await cf(token, `/zones/${zoneId}/dns_records/${id}`, { method: 'DELETE' }).catch(() => undefined);
  }
  return { ok: true as const };
}

export async function connectCloudflareToken(input: {
  token: string;
  workspaceId?: string;
  userId: string;
  zoneId?: string;
}) {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const token = input.token.trim();
  const verified = await verifyCloudflareToken(token);
  if (!verified.ok) return verified;

  const listed = await listCloudflareZones(token);
  if (!listed.ok) return listed;

  const choice = input.zoneId
    ? {
        status: listed.zones.some((zone) => zone.id === input.zoneId) ? ('auto' as const) : ('none' as const),
        zone: listed.zones.find((zone) => zone.id === input.zoneId),
        zones: listed.zones,
      }
    : chooseCloudflareZone(listed.zones);

  if (choice.status === 'none' || (input.zoneId && !choice.zone)) {
    return { ok: false as const, error: 'No Cloudflare zone was found' };
  }
  if (choice.status === 'pick') {
    await upsertIntegration({
      workspaceId,
      kind: 'CLOUDFLARE',
      status: 'PENDING',
      secrets: { token },
      connectedById: input.userId,
      lastError: null,
    });
    return { ok: true as const, needsZone: true as const, zones: choice.zones as CloudflareZone[] };
  }

  const zone = choice.zone!;
  const probe = await probeCloudflareDnsEdit(token, zone.id, zone.name);
  if (!probe.ok) return probe;

  const row = await upsertIntegration({
    workspaceId,
    kind: 'CLOUDFLARE',
    status: 'CONNECTED',
    config: {
      zoneId: zone.id,
      zoneName: zone.name,
      accountId: zone.account?.id,
    },
    secrets: { token },
    connectedById: input.userId,
    lastError: null,
    lastCheckedAt: new Date(),
  });
  return { ok: true as const, needsZone: false as const, integration: row };
}
