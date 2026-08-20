import { getIntegration, getRootDomain } from '@/lib/integrations/store';
import { SECRETS_UNREADABLE_MESSAGE } from '@/lib/integrations/secrets';
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
  // "Stored but unreadable" first: it is the more fundamental failure, and reporting it as
  // "not connected" sent operators to reconnect an integration their own admin screen
  // showed as connected (F-212).
  if (row?.secretsUnreadable) {
    throw new CloudflareDnsError(SECRETS_UNREADABLE_MESSAGE, 500, null);
  }
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

type CfBody<T> = {
  success?: boolean;
  errors?: Array<{ message?: string }>;
  result?: T;
  /** Cloudflare's pagination envelope. Absent on single-object responses. */
  result_info?: { page?: number; total_pages?: number };
};

async function cfBody<T>(token: string, path: string, init?: RequestInit): Promise<CfBody<T>> {
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
  const body = (await response.json().catch(() => null)) as CfBody<T> | null;
  if (!response.ok || body?.success === false) {
    const message = body?.errors?.[0]?.message || `Cloudflare DNS ${response.status}`;
    throw new CloudflareDnsError(message, response.status, body);
  }
  return body ?? {};
}

async function cf<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const body = await cfBody<T>(token, path, init);
  return (body.result ?? body) as T;
}

type DnsRecord = {
  id: string;
  name: string;
  type: string;
  content: string;
  /** Orange cloud. Absent from a response only if Cloudflare stops sending it. */
  proxied?: boolean;
  /** `1` is Cloudflare's "automatic", which is the only TTL a proxied record has. */
  ttl?: number;
};

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
  } as const;
  if (existing) {
    // Content alone is not the record we asked for. A record switched to grey cloud by hand
    // or by another tool still matched on content, so publish called the DNS step a success
    // while the site was served straight off the origin — no WAF, origin IP exposed (F-249).
    const matches =
      existing.content === payload.content &&
      existing.type === payload.type &&
      existing.proxied === payload.proxied &&
      existing.ttl === payload.ttl;
    if (matches) return existing.id;
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

const A_RECORDS_PER_PAGE = 100;
/** 100 pages × 100 = 10 000 A records. Past that the inventory is refused, not truncated. */
const A_RECORD_PAGE_CAP = 100;

/**
 * Every A record in the zone — including the operator's own `www`, `api`, `mail`.
 * This list is an inventory, NOT a set of records Navroop owns: it was called
 * `listManagedARecords`, and the orphan cron read that name literally and deleted
 * anything in it whose label looked like a slug. Ownership is decided by the caller
 * against recorded ids (`lib/jobs/orphans.ts`), never by anything on these rows.
 *
 * It follows Cloudflare's pagination to the end. It used to ask for one page of 100 and
 * return it as the whole zone, so a zone with 101 A records handed the orphan cron a
 * partial picture that the cron could not tell from a complete one — and reported "no
 * orphans" while records accumulated (F-233). A page that fails, or a zone past the cap,
 * throws: the caller (`lib/jobs/orphans.ts`) records a listing failure and refuses to
 * delete on an inventory it could not read to the end. "Could not look" is not "nothing
 * there".
 */
export async function listZoneARecords(workspaceId = DEFAULT_WORKSPACE_ID) {
  const { zoneId, token, root } = await credentials(workspaceId);
  const list: Array<DnsRecord & { created_on?: string }> = [];
  let complete = false;
  for (let page = 1; page <= A_RECORD_PAGE_CAP; page += 1) {
    const body = await cfBody<Array<DnsRecord & { created_on?: string }>>(
      token,
      `/zones/${zoneId}/dns_records?type=A&per_page=${A_RECORDS_PER_PAGE}&page=${page}`,
    );
    const batch = Array.isArray(body.result) ? body.result : [];
    list.push(...batch);
    const totalPages = Number(body.result_info?.total_pages ?? 0);
    // Prefer Cloudflare's own count; fall back to a short page for responses that omit it.
    if (totalPages > 0 ? page >= totalPages : batch.length < A_RECORDS_PER_PAGE) {
      complete = true;
      break;
    }
  }
  if (!complete) {
    throw new CloudflareDnsError(
      `The zone has more than ${A_RECORD_PAGE_CAP * A_RECORDS_PER_PAGE} A records, so this inventory is incomplete.`,
      0,
      null,
    );
  }
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
