import { checkLimit } from '@/lib/plans/limits';
import { prisma } from '@/lib/db';
import type { DeploymentKind } from '@/generated/prisma';
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
 * Publishing consumes a live/preview slot, not credits.
 * Re-publish of an existing non-STOPPED deployment does not take a new slot.
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
