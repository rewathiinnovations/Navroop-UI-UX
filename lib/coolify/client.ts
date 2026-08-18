import { decrypt } from '@/lib/crypto';
import { CoolifyApiError, coolifyErrorMessage } from './errors';
import { getCoolifyCredentials } from './settings';

export type CoolifyClient = {
  baseUrl: string;
  last4: string;
  source: 'env' | 'stored';
  request: (path: string, init?: RequestInit) => Promise<Response>;
  getJson: <T = unknown>(path: string) => Promise<{ ok: boolean; status: number; data: T | null }>;
};

/** Coolify Integration store first, then encrypted AppSetting. No env token. */
export async function getCoolifyClient(): Promise<CoolifyClient | null> {
  const creds = await getCoolifyCredentials();
  if (!creds.token || creds.source === 'none') return null;

  const request: CoolifyClient['request'] = (path, init) => {
    const url = `${creds.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    // Trusted host — do not route through safeFetch.
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

export type CoolifyServerAuth = {
  apiUrl: string;
  apiToken: string;
};

export type CreateApplicationInput = {
  repoUrl: string;
  branch: string;
  domain: string;
  deployType: 'static' | 'node';
  buildCommand: string | null;
  outputDir: string | null;
  startCommand: string | null;
  port: number | null;
  dockerfile?: string | null;
  envVars?: Record<string, string>;
  name?: string;
  projectUuid: string;
  serverIp: string;
  basicAuth?: { username: string; password: string } | null;
};

export type DeploymentHealth = 'healthy' | 'failed' | 'building';

function normalizeBase(url: string) {
  return url.trim().replace(/\/+$/, '');
}

function tokenForServer(server: CoolifyServerAuth) {
  const raw = server.apiToken.trim();
  try {
    if (raw.includes('==') || raw.length > 80) {
      return decrypt(raw);
    }
  } catch {
    /* stored plaintext during create before encrypt, or already decrypted */
  }
  return raw;
}

async function parseBody(response: Response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function coolifyFetch(
  server: CoolifyServerAuth,
  path: string,
  init: RequestInit = {},
  retried = false,
): Promise<{ status: number; data: unknown }> {
  const url = `${normalizeBase(server.apiUrl)}${path.startsWith('/') ? path : `/${path}`}`;
  let response: Response;
  try {
    // Trusted host — do not route through safeFetch.
    response = await fetch(url, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${tokenForServer(server)}`,
        'Content-Type': 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Coolify request failed';
    throw new CoolifyApiError(message, 0, null, path);
  }

  const data = await parseBody(response);
  if (response.ok) return { status: response.status, data };

  if (!retried && response.status >= 500) {
    return coolifyFetch(server, path, init, true);
  }

  throw new CoolifyApiError(
    coolifyErrorMessage(data, `Coolify ${response.status} ${path}`),
    response.status,
    data,
    path,
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function pickUuid(value: unknown): string | null {
  const row = asRecord(value);
  const nested = asRecord(row.application ?? row.data);
  const uuid = row.uuid ?? nested.uuid;
  return typeof uuid === 'string' && uuid ? uuid : null;
}

async function resolveServerUuid(server: CoolifyServerAuth, serverIp: string) {
  const { data } = await coolifyFetch(server, '/api/v1/servers');
  const list = Array.isArray(data) ? data : Array.isArray(asRecord(data).data) ? (asRecord(data).data as unknown[]) : [];
  const match = list.find((item) => {
    const row = asRecord(item);
    return row.ip === serverIp || row.ip === `${serverIp}` || String(row.ip || '').includes(serverIp);
  });
  const uuid = match ? pickUuid(match) : null;
  if (uuid) return uuid;
  if (list.length === 1) {
    const only = pickUuid(list[0]);
    if (only) return only;
  }
  throw new CoolifyApiError(
    `Coolify server UUID was not found for ${serverIp}`,
    422,
    data,
    '/api/v1/servers',
  );
}

async function setEnvVars(server: CoolifyServerAuth, appUuid: string, envVars: Record<string, string>) {
  for (const [key, value] of Object.entries(envVars)) {
    await coolifyFetch(server, `/api/v1/applications/${appUuid}/envs`, {
      method: 'POST',
      body: JSON.stringify({ key, value, is_preview: false, is_literal: true }),
    }).catch(async () => {
      await coolifyFetch(server, `/api/v1/applications/${appUuid}/envs/update`, {
        method: 'PATCH',
        body: JSON.stringify({ key, value }),
      });
    });
  }
}

export async function listApplications(server: CoolifyServerAuth) {
  const { data } = await coolifyFetch(server, '/api/v1/applications');
  const list = Array.isArray(data) ? data : Array.isArray(asRecord(data).data) ? (asRecord(data).data as unknown[]) : [];
  return list.map((item) => {
    const row = asRecord(item);
    const uuid = pickUuid(row) || '';
    const name = typeof row.name === 'string' ? row.name : '';
    const created = row.created_at ?? row.createdAt;
    return {
      uuid,
      name,
      createdAt: typeof created === 'string' ? new Date(created) : new Date(0),
      raw: row,
    };
  }).filter((row) => row.uuid);
}

export async function findApplicationByName(server: CoolifyServerAuth, name: string) {
  const apps = await listApplications(server);
  return apps.find((app) => app.name === name) ?? null;
}

export async function listManagedApplications() {
  const { prisma } = await import('@/lib/db');
  const { serverAuth } = await import('./servers');
  const servers = await prisma.coolifyServer.findMany({ where: { isActive: true } });
  const apps: Array<{ uuid: string; name: string; createdAt: Date }> = [];
  for (const server of servers) {
    try {
      const listed = await listApplications(serverAuth(server));
      for (const app of listed) apps.push({ uuid: app.uuid, name: app.name, createdAt: app.createdAt });
    } catch {
      /* skip unreachable server */
    }
  }
  return apps;
}

export async function createApplication(server: CoolifyServerAuth, input: CreateApplicationInput) {
  const existing = input.name ? await findApplicationByName(server, input.name) : null;
  if (existing) {
    if (input.envVars && Object.keys(input.envVars).length > 0) {
      await setEnvVars(server, existing.uuid, input.envVars);
    }
    return { uuid: existing.uuid, raw: existing.raw, reused: true as const };
  }
  const serverUuid = await resolveServerUuid(server, input.serverIp);
  const buildPack = input.dockerfile ? 'dockerfile' : input.deployType === 'static' && !input.buildCommand ? 'static' : 'nixpacks';
  const body: Record<string, unknown> = {
    project_uuid: input.projectUuid,
    server_uuid: serverUuid,
    environment_name: 'production',
    git_repository: input.repoUrl,
    git_branch: input.branch,
    build_pack: buildPack,
    name: input.name || input.domain,
    domains: `https://${input.domain}`,
    fqdn: `https://${input.domain}`,
    is_static: input.deployType === 'static',
    instant_deploy: false,
    is_auto_deploy_enabled: false,
  };
  if (input.buildCommand) body.build_command = input.buildCommand;
  if (input.outputDir) body.publish_directory = input.outputDir;
  if (input.startCommand) body.start_command = input.startCommand;
  if (input.port) body.ports_exposes = String(input.port);
  if (input.dockerfile) body.dockerfile = input.dockerfile;
  if (input.basicAuth) {
    body.is_http_basic_auth_enabled = true;
    body.http_basic_auth_username = input.basicAuth.username;
    body.http_basic_auth_password = input.basicAuth.password;
  }

  const created = await coolifyFetch(server, '/api/v1/applications/public', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const uuid = pickUuid(created.data);
  if (!uuid) {
    throw new CoolifyApiError('Coolify application UUID was not found', created.status, created.data, '/api/v1/applications/public');
  }
  if (input.envVars && Object.keys(input.envVars).length > 0) {
    await setEnvVars(server, uuid, input.envVars);
  }
  return { uuid, raw: created.data };
}

export async function triggerDeploy(server: CoolifyServerAuth, appUuid: string) {
  const { data } = await coolifyFetch(server, `/api/v1/deploy?uuid=${encodeURIComponent(appUuid)}&force=true`);
  const row = asRecord(Array.isArray(data) ? data[0] : data);
  const deployments = Array.isArray(row.deployments) ? row.deployments : [];
  const first = asRecord(deployments[0] ?? row);
  const deploymentUuid = typeof first.deployment_uuid === 'string' ? first.deployment_uuid : typeof first.uuid === 'string' ? first.uuid : null;
  return { raw: data, deploymentUuid };
}

export async function getDeploymentStatus(server: CoolifyServerAuth, appUuid: string): Promise<{
  health: DeploymentHealth;
  status: string;
  raw: unknown;
}> {
  const { data } = await coolifyFetch(server, `/api/v1/applications/${appUuid}`);
  const row = asRecord(data);
  const status = String(row.status ?? row.fqdn ?? '');
  const lower = status.toLowerCase();
  let health: DeploymentHealth = 'building';
  if (lower.includes('unhealthy') || lower.includes('exited') || lower.includes('failed') || lower.includes('error') || lower.includes('dead')) {
    health = 'failed';
  } else if (lower.includes('healthy') || lower === 'running') {
    health = 'healthy';
  }
  return { health, status, raw: data };
}

export async function setDomain(server: CoolifyServerAuth, appUuid: string, domain: string) {
  const fqdn = domain.startsWith('http') ? domain : `https://${domain}`;
  await coolifyFetch(server, `/api/v1/applications/${appUuid}`, {
    method: 'PATCH',
    body: JSON.stringify({ domains: fqdn, fqdn }),
  });
}

export async function getApplication(server: CoolifyServerAuth, appUuid: string) {
  const { data } = await coolifyFetch(server, `/api/v1/applications/${appUuid}`);
  return asRecord(data);
}

function parseFqdnList(value: unknown): string[] {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function hostFromFqdn(entry: string) {
  return entry
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:redirect.*$/i, '')
    .replace(/:\d+$/, '')
    .toLowerCase();
}

export async function listApplicationHosts(server: CoolifyServerAuth, appUuid: string) {
  const app = await getApplication(server, appUuid);
  return parseFqdnList(app.fqdn ?? app.domains).map(hostFromFqdn);
}

export async function addApplicationDomain(server: CoolifyServerAuth, appUuid: string, hostname: string) {
  const app = await getApplication(server, appUuid);
  const current = parseFqdnList(app.fqdn ?? app.domains);
  const host = hostname.replace(/^https?:\/\//i, '').toLowerCase();
  if (!current.some((entry) => hostFromFqdn(entry) === host)) {
    current.push(`https://${host}`);
  }
  const fqdn = current.join(',');
  await coolifyFetch(server, `/api/v1/applications/${appUuid}`, {
    method: 'PATCH',
    body: JSON.stringify({ domains: fqdn, fqdn }),
  });
}

export async function removeApplicationDomain(server: CoolifyServerAuth, appUuid: string, hostname: string) {
  const app = await getApplication(server, appUuid);
  const host = hostname.replace(/^https?:\/\//i, '').toLowerCase();
  const next = parseFqdnList(app.fqdn ?? app.domains).filter((entry) => hostFromFqdn(entry) !== host);
  const fqdn = next.join(',');
  await coolifyFetch(server, `/api/v1/applications/${appUuid}`, {
    method: 'PATCH',
    body: JSON.stringify({ domains: fqdn, fqdn }),
  });
}

/** Primary is canonical; aliases (including {slug}.{zone}) are listed so Coolify can 301 to primary. */
export async function setApplicationPrimaryRedirects(
  server: CoolifyServerAuth,
  appUuid: string,
  primary: string,
  aliases: string[],
) {
  const seen = new Set<string>();
  const parts: string[] = [];
  const add = (host: string, redirect: boolean) => {
    const clean = host.replace(/^https?:\/\//i, '').toLowerCase();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    parts.push(redirect ? `https://${clean}:redirect` : `https://${clean}`);
  };
  add(primary, false);
  for (const alias of aliases) add(alias, true);
  const fqdn = parts.join(',');
  await coolifyFetch(server, `/api/v1/applications/${appUuid}`, {
    method: 'PATCH',
    body: JSON.stringify({ domains: fqdn, fqdn }),
  });
}

export function applicationListsHostname(app: Record<string, unknown>, hostname: string) {
  const host = hostname.toLowerCase();
  return parseFqdnList(app.fqdn ?? app.domains).some((entry) => hostFromFqdn(entry) === host);
}

export function applicationSslReady(app: Record<string, unknown>, hostname: string) {
  if (!applicationListsHostname(app, hostname)) return false;
  const raw = JSON.stringify(app).toLowerCase();
  if (raw.includes('ssl_certificate') || raw.includes('letsencrypt') || raw.includes('certificate_id')) {
    return true;
  }
  return String(app.fqdn ?? '').toLowerCase().includes(`https://${hostname.toLowerCase()}`);
}

export async function setBasicAuth(
  server: CoolifyServerAuth,
  appUuid: string,
  auth: { username: string; password: string } | null,
) {
  await coolifyFetch(server, `/api/v1/applications/${appUuid}`, {
    method: 'PATCH',
    body: JSON.stringify(
      auth
        ? {
            is_http_basic_auth_enabled: true,
            http_basic_auth_username: auth.username,
            http_basic_auth_password: auth.password,
          }
        : { is_http_basic_auth_enabled: false },
    ),
  });
}

export async function stopApplication(server: CoolifyServerAuth, appUuid: string) {
  await coolifyFetch(server, `/api/v1/applications/${appUuid}/stop`);
}

export async function deleteApplication(server: CoolifyServerAuth, appUuid: string) {
  try {
    await coolifyFetch(server, `/api/v1/applications/${appUuid}`, { method: 'DELETE' });
  } catch (error) {
    if (error instanceof CoolifyApiError && error.status === 404) return;
    throw error;
  }
}

export async function testServerConnection(server: CoolifyServerAuth) {
  try {
    const { status, data } = await coolifyFetch(server, '/api/v1/version');
    const row = asRecord(data);
    const version = typeof data === 'string' ? data : typeof row.version === 'string' ? row.version : 'ok';
    return { ok: true as const, status, version };
  } catch (error) {
    if (error instanceof CoolifyApiError) {
      return { ok: false as const, status: error.status, error: error.message, body: error.body };
    }
    return { ok: false as const, status: 0, error: error instanceof Error ? error.message : 'Connection failed' };
  }
}
