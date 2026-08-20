import { prisma } from '@/lib/db';
import { DEFAULT_WORKSPACE_ID } from '@/lib/publish/constants';
import type {
  IntegrationKind,
  IntegrationStatus,
  IntegrationConfig,
  IntegrationSecrets,
} from './types';
import { SECRETS_UNREADABLE_MESSAGE, encryptSecretsBlob, readSecretsBlob } from './secrets';
import { missingIntegrationKinds } from './messages';

export type DecryptedIntegration = {
  id: string;
  workspaceId: string;
  kind: IntegrationKind;
  status: IntegrationStatus;
  config: IntegrationConfig;
  secrets: IntegrationSecrets;
  /**
   * The row stores a credentials blob this instance cannot decrypt. `secrets` is then empty
   * for a reason that is not "nothing was stored", and every consumer must refuse the row
   * rather than treat it as an unconfigured integration (F-212).
   */
  secretsUnreadable: boolean;
  lastCheckedAt: Date | null;
  lastError: string | null;
  connectedById: string | null;
};

/**
 * Raised when a caller asks for a partial secrets update on a row whose stored blob cannot
 * be read. Merging into an unreadable blob would drop every credential it holds, which is
 * exactly the silent erasure `mergeSecrets` exists to prevent.
 */
export class IntegrationSecretsUnreadableError extends Error {
  kind: IntegrationKind;

  constructor(kind: IntegrationKind) {
    super(SECRETS_UNREADABLE_MESSAGE);
    this.name = 'IntegrationSecretsUnreadableError';
    this.kind = kind;
  }
}

/** Prisma client is regenerated after migrate; SENTRY is a valid IntegrationKind at runtime. */
function prismaKind(kind: IntegrationKind) {
  return kind as 'GITHUB_DEPLOY' | 'CLOUDFLARE' | 'COOLIFY';
}

function asConfig(value: unknown): IntegrationConfig {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as IntegrationConfig)
    : {};
}

/**
 * No cache.
 *
 * `getIntegration` used to hold the decrypted row in a module-level Map for 30 s, with an
 * `invalidateIntegrationCache` that cleared only the calling process's map. The deployment
 * target runs more than one instance (and a deploy overlaps old and new ones), so for up to
 * 30 s after a disconnect another instance kept publishing with a token the operator had
 * just revoked (F-243). The value cached was credential material and the invalidation was
 * advertised as authoritative; it could not be.
 *
 * What replaced it is a primary-key lookup on one row. A publish makes a few dozen of them.
 */
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
  const read = readSecretsBlob(row.secrets);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    kind: row.kind,
    status: row.status,
    config: asConfig(row.config),
    secrets: read.secrets,
    secretsUnreadable: read.unreadable,
    lastCheckedAt: row.lastCheckedAt,
    lastError: row.lastError,
    connectedById: row.connectedById,
  };
}

export async function getIntegration(
  workspaceId: string,
  kind: IntegrationKind,
): Promise<DecryptedIntegration | null> {
  const row = await prisma.integration.findUnique({
    where: { workspaceId_kind: { workspaceId, kind: prismaKind(kind) } },
  });
  return row ? fromRow(row) : null;
}

/**
 * The row when it is usable: CONNECTED *and* its credentials readable. A row whose blob
 * will not decrypt is not a connection, whatever the status column says.
 */
export async function requireConnected(workspaceId: string, kind: IntegrationKind) {
  const row = await getIntegration(workspaceId, kind);
  if (!row || row.status !== 'CONNECTED' || row.secretsUnreadable) return null;
  return row;
}

export async function listIntegrations(workspaceId = DEFAULT_WORKSPACE_ID) {
  const rows = await prisma.integration.findMany({ where: { workspaceId } });
  return rows.map(fromRow);
}

export type PublishReadiness = {
  /** Publish integrations that are not usable, for any reason. */
  missing: IntegrationKind[];
  /** The subset of `missing` that is CONNECTED but whose credentials will not decrypt. */
  unreadable: IntegrationKind[];
};

/**
 * What the publish gate needs: which integrations are unusable, and which of those are
 * unusable because their stored credentials cannot be read rather than because nobody
 * connected them. The two produce different advice, and giving the second one's advice for
 * the first sent operators to reconnect integrations their own screen showed as connected.
 */
export async function getPublishReadiness(
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<PublishReadiness> {
  const rows = await prisma.integration.findMany({
    where: { workspaceId },
    select: { kind: true, status: true, secrets: true },
  });
  const withReadability = rows.map((row) => ({
    kind: row.kind,
    status: row.status,
    secretsUnreadable: readSecretsBlob(row.secrets).unreadable,
  }));
  const missing = missingIntegrationKinds(withReadability);
  const unreadable = withReadability
    .filter((row) => row.status === 'CONNECTED' && row.secretsUnreadable)
    .map((row) => row.kind as IntegrationKind)
    .filter((kind) => missing.includes(kind));
  return { missing, unreadable };
}

export async function getMissingIntegrations(workspaceId = DEFAULT_WORKSPACE_ID) {
  return (await getPublishReadiness(workspaceId)).missing;
}

export async function upsertIntegration(input: {
  workspaceId?: string;
  kind: IntegrationKind;
  status: IntegrationStatus;
  config?: IntegrationConfig;
  /**
   * The complete credential set for this integration. Every stored secret not named here is
   * erased. Use at connect/promotion time, when the caller genuinely owns the whole blob.
   */
  secrets?: IntegrationSecrets | null;
  /**
   * A partial credential update, merged over what is stored — the same semantics `config`
   * has always had. Before this existed every caller looked like a partial update and was
   * a total replace, so writing one secret erased the rest: `sentry/start` saving a client
   * secret destroyed the live auth token, refresh token and expiry (F-213).
   */
  mergeSecrets?: IntegrationSecrets;
  connectedById?: string | null;
  lastError?: string | null;
  lastCheckedAt?: Date | null;
}) {
  if (input.secrets !== undefined && input.mergeSecrets !== undefined) {
    throw new Error('upsertIntegration: pass either secrets (total) or mergeSecrets (partial)');
  }
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const existing = await prisma.integration.findUnique({
    where: { workspaceId_kind: { workspaceId, kind: prismaKind(input.kind) } },
  });

  let nextSecrets: string | null;
  if (input.mergeSecrets !== undefined) {
    const read = readSecretsBlob(existing?.secrets);
    if (read.unreadable) {
      throw new IntegrationSecretsUnreadableError(input.kind);
    }
    // JSON.stringify drops keys whose value is undefined, so passing `{ pendingToken:
    // undefined }` removes that one secret and leaves the rest — which is how the connect
    // wizards clear their staged credentials on promotion.
    nextSecrets = encryptSecretsBlob({ ...read.secrets, ...input.mergeSecrets });
  } else if (input.secrets === undefined) {
    nextSecrets = existing?.secrets ?? null;
  } else {
    nextSecrets = input.secrets ? encryptSecretsBlob(input.secrets) : null;
  }

  // A key set to `undefined` removes it. Prisma's JSON serialisation would drop it anyway,
  // but relying on that leaves "clear this field" resting on an implementation detail, and
  // the connect wizards clear their staged `pendingBaseUrl` through exactly this path.
  const nextConfig = Object.fromEntries(
    Object.entries({ ...asConfig(existing?.config), ...(input.config ?? {}) }).filter(
      ([, value]) => value !== undefined,
    ),
  ) as IntegrationConfig;
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
      lastError: input.lastError === undefined ? (existing?.lastError ?? null) : input.lastError,
      lastCheckedAt:
        input.lastCheckedAt === undefined ? (existing?.lastCheckedAt ?? null) : input.lastCheckedAt,
    },
  });
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
