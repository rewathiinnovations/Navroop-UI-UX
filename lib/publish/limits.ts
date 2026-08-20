import type { DeploymentKind, Prisma } from '@/generated/prisma';
import { checkLimit, withLimit } from '@/lib/plans/limits';
import { prisma } from '@/lib/db';
import { DEFAULT_WORKSPACE_ID } from './constants';

export class PublishLimitError extends Error {
  status = 402;
  reason: string;
  used: number;
  limit: number;

  constructor(message: string, used: number, limit: number, reason = 'plan_limit') {
    super(message);
    this.name = 'PublishLimitError';
    this.reason = reason;
    this.used = used;
    this.limit = limit;
  }
}

/**
 * Take a live/preview slot and do the write that consumes it, in one transaction.
 *
 * The enforcement point for `maxLiveSites` / `maxPreviewSites`. `withLimit` re-counts
 * under an advisory lock keyed on the limit and rolls back if `write` throws, so two
 * concurrent publishes at the ceiling can no longer both insert — which used to
 * over-commit the Coolify server past the number the plan sells (F-307).
 *
 * `write` must be the statement that makes the deployment count: the insert, or the
 * revival of a STOPPED row. Everything else about a publish belongs outside it.
 */
export async function reservePublishSlot<T>(
  workspaceId: string,
  kind: DeploymentKind,
  write: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const key = kind === 'LIVE' ? 'liveSites' : 'previewSites';
  const reservation = await withLimit(workspaceId, key, 1, write);
  if (!reservation.ok) {
    throw new PublishLimitError(
      reservation.message || 'Plan limit is used up — talk to an admin',
      reservation.current,
      reservation.limit,
      reservation.reason || key,
    );
  }
  return reservation.data;
}

/**
 * The pre-flight, and only that: it answers "would a slot be available right now" so the
 * caller can refuse with a 402 before any work starts. It cannot be the enforcement point
 * — the count and the write are separate statements, so two concurrent publishes at the
 * ceiling both pass. {@link reservePublishSlot} is the enforcement point.
 *
 * Re-publish of an existing non-STOPPED deployment does not take a new slot: the row is
 * already counted.
 */
export async function assertPublishSlot(input: {
  workspaceId?: string;
  projectId: string;
  kind: DeploymentKind;
}) {
  const workspaceId = input.workspaceId || DEFAULT_WORKSPACE_ID;
  const existing = await prisma.deployment.findUnique({
    where: { projectId_kind: { projectId: input.projectId, kind: input.kind } },
    select: { status: true },
  });
  if (existing && existing.status !== 'STOPPED') return;

  const key = input.kind === 'LIVE' ? 'liveSites' : 'previewSites';
  const result = await checkLimit(workspaceId, key, 1);
  if (!result.ok) {
    throw new PublishLimitError(
      result.message || 'Plan limit is used up — talk to an admin',
      result.current,
      result.limit,
      result.reason || key,
    );
  }
}

export function publishLimitPayload(error: unknown) {
  if (error instanceof PublishLimitError) {
    return {
      reason: error.reason,
      used: error.used,
      limit: error.limit,
      message: error.message,
    };
  }
  return null;
}
