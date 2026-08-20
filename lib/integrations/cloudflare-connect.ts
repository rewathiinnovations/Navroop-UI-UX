import { asCloudflareZones, chooseCloudflareZone, cloudflarePermissionMessage } from './cloudflare';
import type { CloudflareSecrets, CloudflareZone } from './types';
import { upsertIntegration } from './store';
import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';
import { DEFAULT_WORKSPACE_ID } from '@/lib/publish/constants';

const API = 'https://api.cloudflare.com/client/v4';

type CfBody<T> = {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: T;
};

async function cf<T>(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; body: CfBody<T> }> {
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
        cloudflarePermissionMessage(
          { errors: result.body.errors, status: result.status },
          'verify-token',
        ) ||
        result.body.errors?.[0]?.message ||
        'Cloudflare token is invalid',
    };
  }
  return { ok: true as const };
}

export async function listCloudflareZones(token: string) {
  const result = await cf<unknown>(token, '/zones?per_page=50');
  if (!result.ok) {
    // Cloudflare's own sentence, unless it told us the token is unauthorized for the
    // resource — the one refusal that names a permission. Substituting "Zone → Zone → Read
    // permission missing" for every failure sent operators to re-scope a token that was
    // rate-limited, IP-restricted or on a suspended account (F-248).
    return {
      ok: false as const,
      error:
        cloudflarePermissionMessage(
          { errors: result.body.errors, status: result.status },
          'list-zones',
        ) ||
        result.body.errors?.[0]?.message ||
        `Cloudflare refused the zone list (HTTP ${result.status})`,
    };
  }
  return { ok: true as const, zones: asCloudflareZones(result.body.result) };
}

/**
 * Confirms the token may edit DNS in this zone, by creating and deleting one TXT record.
 *
 * Both halves are now reported. The delete used to be `.catch(() => undefined)` and to run
 * only when the create response happened to carry an `id`, so a failed cleanup — or a
 * response shape the parser did not recognise — left `_navroop-check.<zone>` behind in the
 * operator's production DNS with nothing logged and nothing in the product that knew about
 * it (F-238). A bare catch there also hid the exact permission asymmetry the probe exists to
 * measure: create allowed, delete denied.
 *
 * `strayRecord` is the record we could not remove. The caller surfaces it, because the
 * operator is the only one who can delete it.
 */
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
    // The probe is a DNS write, so 9109 here really is a missing DNS Edit. Every other
    // refusal keeps Cloudflare's own sentence: a rate limit or a suspended account used to
    // be reported as a permission the operator already had (F-248).
    return {
      ok: false as const,
      error:
        cloudflarePermissionMessage(
          { errors: created.body.errors, status: created.status },
          'edit-dns',
        ) ||
        created.body.errors?.[0]?.message ||
        `Cloudflare refused the DNS write (HTTP ${created.status})`,
    };
  }
  const id = created.body.result?.id;
  if (!id) {
    // The record was created and we cannot address it to clean up. Treating that as a pass
    // left a permanent stray record; it is a probe failure, and it names the record so the
    // operator can remove it by hand.
    log.error('cloudflare.probe_record_id_missing', {
      zoneId,
      record: name,
      message: 'The permission-check TXT record was created but its id was not in the response.',
    });
    return {
      ok: false as const,
      error: `Cloudflare accepted the permission check but did not return the record id, so ${name} could not be removed. Delete it in the Cloudflare dashboard and try again.`,
      strayRecord: name,
    };
  }
  const deleted = await cf(token, `/zones/${zoneId}/dns_records/${id}`, { method: 'DELETE' }).catch(
    (error: unknown) => ({
      ok: false,
      status: 0,
      body: { errors: [{ message: error instanceof Error ? error.message : String(error) }] },
    }),
  );
  if (!deleted.ok) {
    const reason =
      cloudflarePermissionMessage(
        { errors: deleted.body.errors, status: deleted.status },
        'edit-dns',
      ) ||
      deleted.body.errors?.[0]?.message ||
      `Cloudflare ${deleted.status}`;
    log.error('cloudflare.probe_record_not_removed', {
      zoneId,
      record: name,
      status: deleted.status,
      message: 'The permission-check TXT record could not be deleted and is still in the zone.',
    });
    return {
      ok: true as const,
      strayRecord: name,
      warning: `The permission check left ${name} in your zone — deleting it failed (${reason}). Remove it in the Cloudflare dashboard.`,
    };
  }
  return { ok: true as const, strayRecord: null, warning: null };
}

/**
 * Records the token the operator just pasted while the zone picker is open, without
 * disturbing the live connection.
 *
 * This branch used to write `status: 'PENDING'` and the candidate token over the live row.
 * The publish gate counts only CONNECTED, so a token that mapped to more than one zone
 * blocked publishing workspace-wide the moment it was pasted — and `peekRootDomain` started
 * returning null, which empties `expectedUrl` on every deployment (F-214).
 *
 * On a first-time connect there is nothing to protect, so PENDING is accurate and stays.
 */
export async function stageCloudflareCandidate(input: {
  workspaceId?: string;
  token: string;
  userId: string;
}) {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const existing = await prisma.integration.findUnique({
    where: { workspaceId_kind: { workspaceId, kind: 'CLOUDFLARE' } },
  });
  return upsertIntegration({
    workspaceId,
    kind: 'CLOUDFLARE',
    status: existing?.status === 'CONNECTED' ? 'CONNECTED' : 'PENDING',
    mergeSecrets: { pendingToken: input.token.trim() },
    connectedById: input.userId,
    lastError: null,
  });
}

/**
 * The token the zone picker should use: the staged candidate when one is in flight,
 * otherwise the live one.
 */
export function cloudflareWizardToken(row: { secrets: CloudflareSecrets }): string | null {
  return (row.secrets.pendingToken || row.secrets.token || '').trim() || null;
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
        status: listed.zones.some((zone) => zone.id === input.zoneId)
          ? ('auto' as const)
          : ('none' as const),
        zone: listed.zones.find((zone) => zone.id === input.zoneId),
        zones: listed.zones,
      }
    : chooseCloudflareZone(listed.zones);

  if (choice.status === 'none' || (input.zoneId && !choice.zone)) {
    return { ok: false as const, error: 'No Cloudflare zone was found' };
  }
  if (choice.status === 'pick') {
    await stageCloudflareCandidate({ workspaceId, token, userId: input.userId });
    return { ok: true as const, needsZone: true as const, zones: choice.zones as CloudflareZone[] };
  }

  const zone = choice.zone!;
  const probe = await probeCloudflareDnsEdit(token, zone.id, zone.name);
  if (!probe.ok) return probe;

  // Promotion: the candidate becomes the live token and the staged one goes away. `secrets`
  // (total) because this caller owns the whole Cloudflare blob — the token is all of it.
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
    // A probe that left a record behind is the operator's to clean up, so it is recorded on
    // the row `/admin/integrations` and `/admin/health` already render.
    lastError: probe.warning ?? null,
    lastCheckedAt: new Date(),
  });
  return {
    ok: true as const,
    needsZone: false as const,
    integration: row,
    warning: probe.warning ?? null,
    strayRecord: probe.strayRecord ?? null,
  };
}
