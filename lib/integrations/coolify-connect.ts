import { DEFAULT_WORKSPACE_ID } from '@/lib/publish/constants';
import { prisma } from '@/lib/db';
import { encryptServerToken } from '@/lib/coolify/server-token';
import { assertSafeUrl, UnsafeUrlError, type DnsLookupFn } from '@/lib/security/url-guard';
import type { CoolifyConfig, CoolifySecrets } from './types';
import { upsertIntegration } from './store';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const nested = asRecord(value).data;
  return Array.isArray(nested) ? nested : [];
}

export class CoolifyBaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoolifyBaseUrlError';
  }
}

/**
 * Validates an operator-typed Coolify address before anything fetches it.
 *
 * The connect route used to hand the request body's `baseUrl` straight to `fetch` after a
 * `trim()`, and reflect the response status back in the error message — a working internal
 * port scanner and cloud-metadata probe for anyone with ADMIN (F-228). The "trusted host"
 * exemption that lets `lib/coolify/client.ts` skip the guard covers the *configured*
 * Coolify; it does not cover a host typed into a form, which is exactly what this is.
 *
 * The guard is applied to the origin without its port, and the port is then kept. That is
 * deliberate and it is the only check not applied: a self-hosted Coolify commonly listens on
 * 8000, so `assertSafeUrl`'s 80/443 restriction would refuse a legitimate install. Every
 * check the finding is about — protocol, embedded credentials, private and link-local
 * hostnames, and DNS answers that resolve into a private range — still runs, and a rejection
 * is counted on /admin/usage like every other SSRF attempt.
 *
 * Returns the normalised origin, which also drops any path an operator pasted.
 */
export async function assertCoolifyBaseUrl(
  raw: string,
  opts: { lookup?: DnsLookupFn; userId?: string } = {},
): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new CoolifyBaseUrlError('Enter the full Coolify address, including https://');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CoolifyBaseUrlError('The Coolify address must start with http:// or https://');
  }
  // Reconstructing the URL below drops the userinfo, so the guard would never see it. Any
  // check the reconstruction discards has to be made here; the port is the only one this
  // function means to skip.
  if (parsed.username || parsed.password) {
    throw new CoolifyBaseUrlError('Remove the username and password from the Coolify address');
  }
  try {
    await assertSafeUrl(`${parsed.protocol}//${parsed.hostname}`, opts);
  } catch (error) {
    if (error instanceof UnsafeUrlError) {
      throw new CoolifyBaseUrlError(error.message);
    }
    throw error;
  }
  return parsed.origin;
}

async function coolifyJson(baseUrl: string, token: string, path: string, init?: RequestInit) {
  // The caller has already put `baseUrl` through `assertCoolifyBaseUrl`.
  const response = await fetch(`${baseUrl}${path.startsWith('/') ? path : `/${path}`}`, {
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

/**
 * Records the token and address the operator just verified, without disturbing the live
 * connection.
 *
 * The first half of this wizard used to write `status: 'PENDING'` and the candidate token
 * over the row that gates publishing, before the operator had selected a single server. The
 * gate counts only CONNECTED, so pasting a token to re-check a connection blocked publishing
 * workspace-wide until the wizard was finished — and nothing said so (F-214). The candidate
 * now lives in `pendingToken` / `pendingBaseUrl` and is promoted by `saveCoolifySelection`.
 *
 * On a first-time connect there is no live connection to protect, so PENDING is still what
 * the row says: it is accurate, and publishing was already blocked.
 */
export async function stageCoolifyCandidate(input: {
  workspaceId?: string;
  baseUrl: string;
  token: string;
  userId: string;
}) {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const existing = await prisma.integration.findUnique({
    where: { workspaceId_kind: { workspaceId, kind: 'COOLIFY' } },
  });
  const live = existing?.status === 'CONNECTED';
  return upsertIntegration({
    workspaceId,
    kind: 'COOLIFY',
    status: live ? 'CONNECTED' : 'PENDING',
    config: { pendingBaseUrl: input.baseUrl },
    mergeSecrets: { pendingToken: input.token },
    connectedById: input.userId,
    lastError: null,
  });
}

/**
 * The credentials the second half of the wizard should use: the staged candidate when one is
 * in flight, otherwise the live connection (so re-picking a project on an already-connected
 * Coolify keeps working without re-pasting the token).
 */
export function coolifyWizardCredentials(row: {
  config: CoolifyConfig;
  secrets: CoolifySecrets;
}): { baseUrl: string; token: string } | null {
  const baseUrl = (row.config.pendingBaseUrl || row.config.baseUrl || '').trim();
  const token = (row.secrets.pendingToken || row.secrets.token || '').trim();
  if (!baseUrl || !token) return null;
  return { baseUrl, token };
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
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
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
      maxDeployments:
        server.maxDeployments && server.maxDeployments > 0 ? server.maxDeployments : 50,
    };
    const row = existing
      ? await prisma.coolifyServer.update({ where: { id: existing.id }, data })
      : await prisma.coolifyServer.create({ data });
    created.push(row);
  }

  // Promotion: the candidate becomes the live connection and the staging fields go away.
  // `secrets` (total) rather than `mergeSecrets` because this caller genuinely owns the
  // whole blob — the token it was handed is the only Coolify credential there is.
  const integration = await upsertIntegration({
    workspaceId,
    kind: 'COOLIFY',
    status: 'CONNECTED',
    config: {
      baseUrl,
      pendingBaseUrl: undefined,
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
