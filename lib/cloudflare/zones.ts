import { getIntegration } from '@/lib/integrations/store';
import { DEFAULT_WORKSPACE_ID } from '@/lib/publish/constants';
import { CloudflareDnsError } from './dns';

const API = 'https://api.cloudflare.com/client/v4';

type ZoneResult = {
  id: string;
  name: string;
  name_servers?: string[];
  status?: string;
};

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
    errors?: Array<{ message?: string; code?: number }>;
    result?: T;
  } | null;
  if (!response.ok || body?.success === false) {
    const message = body?.errors?.[0]?.message || `Cloudflare zone ${response.status}`;
    throw new CloudflareDnsError(message, response.status, body);
  }
  return (body?.result ?? body) as T;
}

async function credentials(workspaceId = DEFAULT_WORKSPACE_ID) {
  const row = await getIntegration(workspaceId, 'CLOUDFLARE');
  const token = row?.secrets.token?.trim();
  const accountId = row?.config.accountId?.trim();
  if (row?.status !== 'CONNECTED' || !token) {
    throw new CloudflareDnsError('Cloudflare is not connected', 500, null);
  }
  return { token, accountId: accountId || null };
}

/** Adds a client hostname as its own zone. Never deletes a zone. */
export async function createOrGetClientZone(hostname: string, workspaceId = DEFAULT_WORKSPACE_ID) {
  const { token, accountId } = await credentials(workspaceId);
  const existing = await cf<ZoneResult[]>(token, `/zones?name=${encodeURIComponent(hostname)}`);
  const found = Array.isArray(existing) ? existing.find((row) => row.name === hostname) : null;
  if (found) {
    return {
      zoneId: found.id,
      nameservers: found.name_servers ?? [],
      created: false,
    };
  }
  if (!accountId) {
    throw new CloudflareDnsError('Cloudflare account id is missing on the connected integration', 422, null);
  }
  const created = await cf<ZoneResult>(token, '/zones', {
    method: 'POST',
    body: JSON.stringify({
      name: hostname,
      account: { id: accountId },
      type: 'full',
      jump_start: false,
    }),
  });
  return {
    zoneId: created.id,
    nameservers: created.name_servers ?? [],
    created: true,
  };
}

export async function upsertClientZoneRecord(input: {
  workspaceId?: string;
  zoneId: string;
  type: 'A' | 'CNAME' | 'TXT';
  name: string;
  content: string;
}) {
  const { token } = await credentials(input.workspaceId);
  const records = await cf<Array<{ id: string; name: string; type: string }>>(
    token,
    `/zones/${input.zoneId}/dns_records?type=${input.type}&name=${encodeURIComponent(input.name)}`,
  );
  const list = Array.isArray(records) ? records : [];
  const payload = {
    type: input.type,
    name: input.name,
    content: input.content,
    ttl: 300,
    proxied: input.type !== 'TXT',
  };
  if (list[0]) {
    await cf(token, `/zones/${input.zoneId}/dns_records/${list[0].id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    return list[0].id;
  }
  const created = await cf<{ id: string }>(token, `/zones/${input.zoneId}/dns_records`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return created.id;
}
