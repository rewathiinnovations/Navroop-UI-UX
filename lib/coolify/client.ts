import { getCoolifyCredentials } from './settings';

export type CoolifyClient = {
  baseUrl: string;
  last4: string;
  source: 'env' | 'stored';
  request: (path: string, init?: RequestInit) => Promise<Response>;
  getJson: <T = unknown>(path: string) => Promise<{ ok: boolean; status: number; data: T | null }>;
};

/** Env `COOLIFY_API_TOKEN` wins over the encrypted AppSetting secret. */
export async function getCoolifyClient(): Promise<CoolifyClient | null> {
  const creds = await getCoolifyCredentials();
  if (!creds.token || creds.source === 'none') return null;

  const request: CoolifyClient['request'] = (path, init) => {
    const url = `${creds.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    return fetch(url, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${creds.token}`,
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ...(init?.headers ?? {}),
      },
    });
  };

  return {
    baseUrl: creds.baseUrl,
    last4: creds.last4 ?? '',
    source: creds.source,
    request,
    async getJson<T = unknown>(path: string) {
      const response = await request(path);
      const data = (await response.json().catch(() => null)) as T | null;
      return { ok: response.ok, status: response.status, data };
    },
  };
}

export async function testCoolifyApiConnection() {
  const client = await getCoolifyClient();
  if (!client) {
    return { ok: false as const, status: 0, error: 'Coolify API token is not configured' };
  }

  const version = await client.getJson<{ version?: string } | string>('/api/v1/version');
  if (version.ok) {
    const raw = version.data;
    const label =
      typeof raw === 'string'
        ? raw
        : raw && typeof raw === 'object' && typeof raw.version === 'string'
          ? raw.version
          : 'ok';
    return { ok: true as const, status: version.status, endpoint: '/api/v1/version', version: label };
  }

  const servers = await client.getJson('/api/v1/servers');
  if (servers.ok) {
    return { ok: true as const, status: servers.status, endpoint: '/api/v1/servers' };
  }

  return {
    ok: false as const,
    status: version.status || servers.status,
    error: `Coolify API returned ${version.status || servers.status}`,
    endpoint: version.status ? '/api/v1/version' : '/api/v1/servers',
  };
}
