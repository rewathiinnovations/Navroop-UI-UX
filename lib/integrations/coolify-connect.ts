import { DEFAULT_WORKSPACE_ID } from '@/lib/publish/constants';
import { prisma } from '@/lib/db';
import { encryptServerToken } from '@/lib/coolify/servers';
import { upsertIntegration } from './store';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const nested = asRecord(value).data;
  return Array.isArray(nested) ? nested : [];
}

function normalizeBase(url: string) {
  return url.trim().replace(/\/+$/, '');
}

async function coolifyJson(baseUrl: string, token: string, path: string, init?: RequestInit) {
  // Trusted host — do not route through safeFetch.
  const response = await fetch(`${normalizeBase(baseUrl)}${path.startsWith('/') ? path : `/${path}`}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, data };
}

export type DiscoveredServer = {
  uuid: string;
  name: string;
  ip: string;
};

export type DiscoveredProject = {
  uuid: string;
  name: string;
};

export function parseCoolifyServers(raw: unknown): DiscoveredServer[] {
  return asList(raw)
    .map((item) => {
      const row = asRecord(item);
      const uuid = typeof row.uuid === 'string' ? row.uuid : '';
      const name = typeof row.name === 'string' ? row.name : uuid;
      const ip = typeof row.ip === 'string' ? row.ip : '';
      if (!uuid || !ip) return null;
      return { uuid, name, ip };
    })
    .filter((row): row is DiscoveredServer => Boolean(row));
}

export function parseCoolifyProjects(raw: unknown): DiscoveredProject[] {
  return asList(raw)
    .map((item) => {
      const row = asRecord(item);
      const uuid = typeof row.uuid === 'string' ? row.uuid : '';
      const name = typeof row.name === 'string' ? row.name : uuid;
      if (!uuid) return null;
      return { uuid, name };
    })
    .filter((row): row is DiscoveredProject => Boolean(row));
}

export async function discoverCoolify(baseUrl: string, token: string) {
  const version = await coolifyJson(baseUrl, token, '/api/v1/version');
  if (!version.ok) {
    const servers = await coolifyJson(baseUrl, token, '/api/v1/servers');
    if (!servers.ok) {
      return { ok: false as const, error: `Coolify API ${version.status || servers.status}` };
    }
  }
  const [servers, projects] = await Promise.all([
    coolifyJson(baseUrl, token, '/api/v1/servers'),
    coolifyJson(baseUrl, token, '/api/v1/projects'),
  ]);
  if (!servers.ok) return { ok: false as const, error: `Coolify servers ${servers.status}` };
  return {
    ok: true as const,
    servers: parseCoolifyServers(servers.data),
    projects: projects.ok ? parseCoolifyProjects(projects.data) : [],
  };
}

export async function createCoolifyProject(baseUrl: string, token: string, name = 'Navroop') {
  const created = await coolifyJson(baseUrl, token, '/api/v1/projects', {
    method: 'POST',
    body: JSON.stringify({ name, description: 'Navroop publish' }),
  });
  if (!created.ok) {
    return { ok: false as const, error: `Coolify project create ${created.status}` };
  }
  const row = asRecord(created.data);
  const uuid = typeof row.uuid === 'string' ? row.uuid : '';
  if (!uuid) return { ok: false as const, error: 'Coolify project UUID was not found' };
  return { ok: true as const, project: { uuid, name } };
}

export async function saveCoolifySelection(input: {
  workspaceId?: string;
  userId: string;
  baseUrl: string;
  token: string;
  projectUuid: string;
  projectName?: string;
  servers: Array<{ uuid: string; name: string; ip: string; maxDeployments?: number }>;
}) {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const baseUrl = normalizeBase(input.baseUrl);
  const token = input.token.trim();
  if (input.servers.length === 0) {
    return { ok: false as const, error: 'Select at least one server' };
  }

  const created = [];
  for (const server of input.servers) {
    const existing = await prisma.coolifyServer.findFirst({
      where: { apiUrl: baseUrl, serverIp: server.ip },
    });
    const data = {
      name: server.name,
      apiUrl: baseUrl,
      apiToken: encryptServerToken(token),
      serverIp: server.ip,
      projectUuid: input.projectUuid,
      isActive: true,
      maxDeployments: server.maxDeployments && server.maxDeployments > 0 ? server.maxDeployments : 50,
    };
    const row = existing
      ? await prisma.coolifyServer.update({ where: { id: existing.id }, data })
      : await prisma.coolifyServer.create({ data });
    created.push(row);
  }

  const integration = await upsertIntegration({
    workspaceId,
    kind: 'COOLIFY',
    status: 'CONNECTED',
    config: {
      baseUrl,
      projectUuid: input.projectUuid,
      projectName: input.projectName || 'Navroop',
      serverCount: created.length,
    },
    secrets: { token },
    connectedById: input.userId,
    lastError: null,
    lastCheckedAt: new Date(),
  });

  return { ok: true as const, integration, servers: created };
}
