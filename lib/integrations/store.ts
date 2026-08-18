import { prisma } from '@/lib/db';
import { DEFAULT_WORKSPACE_ID } from '@/lib/publish/constants';
import type { IntegrationKind, IntegrationStatus, IntegrationConfig, IntegrationSecrets } from './types';
import { decryptSecretsBlob, encryptSecretsBlob } from './secrets';
import { missingIntegrationKinds } from './messages';

export type DecryptedIntegration = {
  id: string;
  workspaceId: string;
  kind: IntegrationKind;
  status: IntegrationStatus;
  config: IntegrationConfig;
  secrets: IntegrationSecrets;
  lastCheckedAt: Date | null;
  lastError: string | null;
  connectedById: string | null;
};

const cache = new Map<string, { value: DecryptedIntegration | null; expiresAt: number }>();
const CACHE_MS = 30_000;

function cacheKey(workspaceId: string, kind: IntegrationKind) {
  return `${workspaceId}:${kind}`;
}

/** Prisma client is regenerated after migrate; SENTRY is a valid IntegrationKind at runtime. */
function prismaKind(kind: IntegrationKind) {
  return kind as 'GITHUB_DEPLOY' | 'CLOUDFLARE' | 'COOLIFY';
}

export function invalidateIntegrationCache(workspaceId?: string, kind?: IntegrationKind) {
  if (!workspaceId) {
    cache.clear();
    return;
  }
  if (kind) {
    cache.delete(cacheKey(workspaceId, kind));
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(`${workspaceId}:`)) cache.delete(key);
  }
}

function asConfig(value: unknown): IntegrationConfig {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as IntegrationConfig)
    : {};
}

function fromRow(row: {
  id: string;
  workspaceId: string;
  kind: IntegrationKind;
  status: IntegrationStatus;
  config: unknown;
  secrets: string | null;
  lastCheckedAt: Date | null;
  lastError: string | null;
  connectedById: string | null;
}): DecryptedIntegration {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    kind: row.kind,
    status: row.status,
    config: asConfig(row.config),
    secrets: decryptSecretsBlob(row.secrets),
    lastCheckedAt: row.lastCheckedAt,
    lastError: row.lastError,
    connectedById: row.connectedById,
  };
}

export async function getIntegration(
  workspaceId: string,
  kind: IntegrationKind,
): Promise<DecryptedIntegration | null> {
  const key = cacheKey(workspaceId, kind);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const row = await prisma.integration.findUnique({
    where: { workspaceId_kind: { workspaceId, kind: prismaKind(kind) } },
  });
  const value = row ? fromRow(row) : null;
  cache.set(key, { value, expiresAt: Date.now() + CACHE_MS });
  return value;
}

export async function requireConnected(workspaceId: string, kind: IntegrationKind) {
  const row = await getIntegration(workspaceId, kind);
  if (!row || row.status !== 'CONNECTED') return null;
  return row;
}

export async function listIntegrations(workspaceId = DEFAULT_WORKSPACE_ID) {
  const rows = await prisma.integration.findMany({ where: { workspaceId } });
  return rows.map(fromRow);
}

export async function getMissingIntegrations(workspaceId = DEFAULT_WORKSPACE_ID) {
  const rows = await prisma.integration.findMany({
    where: { workspaceId },
    select: { kind: true, status: true },
  });
  return missingIntegrationKinds(rows);
}

export async function upsertIntegration(input: {
  workspaceId?: string;
  kind: IntegrationKind;
  status: IntegrationStatus;
  config?: IntegrationConfig;
  secrets?: IntegrationSecrets | null;
  connectedById?: string | null;
  lastError?: string | null;
  lastCheckedAt?: Date | null;
}) {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const existing = await prisma.integration.findUnique({
    where: { workspaceId_kind: { workspaceId, kind: prismaKind(input.kind) } },
  });
  const nextSecrets =
    input.secrets === undefined
      ? existing?.secrets ?? null
      : input.secrets
        ? encryptSecretsBlob(input.secrets)
        : null;
  const nextConfig = {
    ...asConfig(existing?.config),
    ...(input.config ?? {}),
  };
  const row = await prisma.integration.upsert({
    where: { workspaceId_kind: { workspaceId, kind: prismaKind(input.kind) } },
    create: {
      workspaceId,
      kind: prismaKind(input.kind),
      status: input.status,
      config: nextConfig,
      secrets: nextSecrets,
      connectedById: input.connectedById ?? null,
      lastError: input.lastError ?? null,
      lastCheckedAt: input.lastCheckedAt ?? null,
    },
    update: {
      status: input.status,
      config: nextConfig,
      secrets: nextSecrets,
      ...(input.connectedById !== undefined ? { connectedById: input.connectedById } : {}),
      lastError: input.lastError === undefined ? existing?.lastError ?? null : input.lastError,
      lastCheckedAt: input.lastCheckedAt === undefined ? existing?.lastCheckedAt ?? null : input.lastCheckedAt,
    },
  });
  invalidateIntegrationCache(workspaceId, input.kind);
  if (input.status === 'CONNECTED') {
    const { writeAudit } = await import('@/lib/audit/log');
    const actor = input.connectedById
      ? await prisma.user.findUnique({
          where: { id: input.connectedById },
          select: { email: true },
        })
      : null;
    await writeAudit({
      actorId: input.connectedById ?? null,
      actorEmail: actor?.email || 'unknown',
      action: 'integration.connect',
      workspaceId,
      targetType: 'integration',
      targetId: input.kind,
      after: { kind: input.kind, status: 'CONNECTED' },
    });
  }
  return fromRow(row);
}

export async function disconnectIntegration(input: {
  workspaceId?: string;
  kind: IntegrationKind;
}) {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const row = await prisma.integration.update({
    where: { workspaceId_kind: { workspaceId, kind: prismaKind(input.kind) } },
    data: {
      status: 'DISCONNECTED',
      secrets: null,
      lastError: null,
      connectedById: null,
    },
  });
  invalidateIntegrationCache(workspaceId, input.kind);
  return fromRow(row);
}

/**
 * Records an operator-facing warning on an integration row without changing its status.
 *
 * `lastError` is already rendered by `/admin/integrations` and `/admin/health`, so it is
 * where a "this succeeded but left something behind" state becomes visible.
 */
export async function setIntegrationLastError(input: {
  workspaceId?: string;
  kind: IntegrationKind;
  message: string | null;
}) {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const row = await prisma.integration.update({
    where: { workspaceId_kind: { workspaceId, kind: prismaKind(input.kind) } },
    data: { lastError: input.message },
  });
  invalidateIntegrationCache(workspaceId, input.kind);
  return fromRow(row);
}

export async function peekRootDomain(workspaceId = DEFAULT_WORKSPACE_ID) {
  const row = await requireConnected(workspaceId, 'CLOUDFLARE');
  return row?.config.zoneName?.trim() || null;
}

export async function getRootDomain(workspaceId = DEFAULT_WORKSPACE_ID) {
  const zone = await peekRootDomain(workspaceId);
  if (!zone) {
    throw new Error('Cloudflare is not connected');
  }
  return zone;
}

export async function countLiveDeployments(workspaceId = DEFAULT_WORKSPACE_ID) {
  return prisma.deployment.count({
    where: { workspaceId, status: 'LIVE' },
  });
}
