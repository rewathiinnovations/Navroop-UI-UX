import { getIntegration, getRootDomain } from '@/lib/integrations/store';
import { DEFAULT_WORKSPACE_ID } from '@/lib/publish/constants';

const API = 'https://api.cloudflare.com/client/v4';

export class CloudflareDnsError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'CloudflareDnsError';
    this.status = status;
    this.body = body;
  }
}

async function credentials(workspaceId = DEFAULT_WORKSPACE_ID) {
  const row = await getIntegration(workspaceId, 'CLOUDFLARE');
  const zoneId = row?.config.zoneId?.trim();
  const token = row?.secrets.token?.trim();
  const root = row?.config.zoneName?.trim();
  if (row?.status !== 'CONNECTED' || !zoneId || !token || !root) {
    throw new CloudflareDnsError('Cloudflare is not connected', 500, null);
  }
  return { zoneId, token, root };
}

function fqdn(subdomain: string, root: string) {
  const label = subdomain
    .replace(/\.$/, '')
    .replace(new RegExp(`\\.${root.replace(/\./g, '\\.')}$`), '');
  return `${label}.${root}`;
}

async function cf<T>(token: string, path: string, init?: RequestInit): Promise<T> {
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
  const body = (await response.json().catch(() => null)) as {
    success?: boolean;
    errors?: Array<{ message?: string }>;
    result?: T;
  } | null;
  if (!response.ok || body?.success === false) {
    const message = body?.errors?.[0]?.message || `Cloudflare DNS ${response.status}`;
    throw new CloudflareDnsError(message, response.status, body);
  }
  return (body?.result ?? body) as T;
}

type DnsRecord = { id: string; name: string; type: string; content: string };

async function findARecord(token: string, zoneId: string, name: string): Promise<DnsRecord | null> {
  const records = await cf<DnsRecord[]>(
    token,
    `/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(name)}`,
  );
  const list = Array.isArray(records) ? records : [];
  return list[0] ?? null;
}

/** Creates or updates a proxied A record. Publishing twice must not duplicate. */
export async function upsertARecord(
  subdomain: string,
  ip: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
) {
  const { zoneId, token, root } = await credentials(workspaceId);
  const name = fqdn(subdomain, root);
  const existing = await findARecord(token, zoneId, name);
  const payload = {
    type: 'A',
    name,
    content: ip,
    proxied: true,
    ttl: 1,
  };
  if (existing) {
    if (existing.content === ip) return existing.id;
    const updated = await cf<DnsRecord>(token, `/zones/${zoneId}/dns_records/${existing.id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    return updated.id;
  }
  const created = await cf<DnsRecord>(token, `/zones/${zoneId}/dns_records`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return created.id;
}

/**
 * Every A record in the zone — including the operator's own `www`, `api`, `mail`.
 * This list is an inventory, NOT a set of records Navroop owns: it was called
 * `listManagedARecords`, and the orphan cron read that name literally and deleted
 * anything in it whose label looked like a slug. Ownership is decided by the caller
 * against recorded ids (`lib/jobs/orphans.ts`), never by anything on these rows.
 */
export async function listZoneARecords(workspaceId = DEFAULT_WORKSPACE_ID) {
  const { zoneId, token, root } = await credentials(workspaceId);
  const records = await cf<Array<DnsRecord & { created_on?: string }>>(
    token,
    `/zones/${zoneId}/dns_records?type=A&per_page=100`,
  );
  const list = Array.isArray(records) ? records : [];
  return list.map((row) => ({
    id: row.id,
    name: row.name,
    // No `created_on` means the age is unknown. The old `new Date(0)` fallback turned
    // that into "created in 1970", i.e. instantly past the cron's 24h grace period.
    createdAt: row.created_on ? new Date(row.created_on) : null,
    zone: root,
  }));
}

export async function deleteRecord(recordId: string, workspaceId = DEFAULT_WORKSPACE_ID) {
  if (!recordId) return;
  const { zoneId, token } = await credentials(workspaceId);
  try {
    await cf(token, `/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE' });
  } catch (error) {
    if (error instanceof CloudflareDnsError && error.status === 404) return;
    throw error;
  }
}

export { getRootDomain };
