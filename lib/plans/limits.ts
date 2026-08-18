import type { Plan, Workspace } from '@/generated/prisma';
import { prisma } from '@/lib/db';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { notifyAdminsCredit80 } from './alerts';
import { creditDenialMessage, limitDenialMessage } from './messages';
import { log } from '@/lib/logger';
import { setSentryActionContext } from '@/lib/sentry/context';
import type {
  CreditAction,
  CreditCheckResult,
  LimitCheckResult,
  LimitKind,
} from './types';

export const CREDIT_COSTS = {
  generation: 1,
  image: 2,
  import: 5,
  audit: 1,
  evolution: 20,
} as const satisfies Record<CreditAction, number>;

export { creditDenialMessage, limitDenialMessage } from './messages';
export type { CreditAction, CreditCheckResult, LimitCheckResult, LimitKind } from './types';

export function isUnlimited(limit: number) {
  return limit === -1;
}

export function shouldRollCreditPeriod(periodStart: Date, now = new Date()) {
  return addMonths(periodStart, 1).getTime() <= now.getTime();
}

export function addMonths(start: Date, months: number) {
  const next = new Date(start.getTime());
  const day = next.getUTCDate();
  next.setUTCMonth(next.getUTCMonth() + months);
  if (next.getUTCDate() < day) {
    next.setUTCDate(0);
  }
  return next;
}

export function currentPeriodStart(periodStart: Date, now = new Date()) {
  let cursor = periodStart;
  while (shouldRollCreditPeriod(cursor, now)) {
    cursor = addMonths(cursor, 1);
  }
  return cursor;
}

export async function ensureWorkspace(workspaceId = WORKSPACE_ROW_ID) {
  return prisma.workspace.upsert({
    where: { id: workspaceId },
    create: { id: workspaceId, storageBytes: 0 },
    update: {},
  });
}

export async function getEffectivePlan(workspaceId = WORKSPACE_ROW_ID): Promise<Plan> {
  const workspace = await ensureWorkspace(workspaceId);
  if (workspace.planId) {
    const assigned = await prisma.plan.findUnique({ where: { id: workspace.planId } });
    if (assigned) return assigned;
  }
  const fallback = await prisma.plan.findFirst({
    where: { isDefault: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!fallback) {
    throw new Error('No default plan is configured');
  }
  return fallback;
}

export async function rollCreditPeriodIfNeeded(workspaceId = WORKSPACE_ROW_ID): Promise<Workspace> {
  const workspace = await ensureWorkspace(workspaceId);
  const now = new Date();
  if (!shouldRollCreditPeriod(workspace.creditsPeriodStart, now)) {
    return workspace;
  }
  const nextStart = currentPeriodStart(workspace.creditsPeriodStart, now);
  await prisma.$executeRaw`
    UPDATE "Workspace"
    SET
      "creditsUsed" = 0,
      "creditsPeriodStart" = ${nextStart},
      "creditAlert80Sent" = false,
      "sandboxMinutesUsed" = 0,
      "spendUsd" = 0,
      "spendAlert80Sent" = false,
      "generationPaused" = CASE WHEN "pauseReason" = 'SPEND_LIMIT' THEN false ELSE "generationPaused" END,
      "pauseReason" = CASE WHEN "pauseReason" = 'SPEND_LIMIT' THEN NULL ELSE "pauseReason" END
    WHERE id = ${workspace.id}
  `;
  return prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
}

function logCreditDenial(workspaceId: string, userId: string, action: CreditAction, reason: string) {
  setSentryActionContext({ action, workspaceId });
  log.warn('credits.denied', { action, workspaceId, userId, reason });
}

export async function checkCredits(
  workspaceId: string,
  userId: string,
  action: CreditAction,
): Promise<CreditCheckResult> {
  const workspace = await rollCreditPeriodIfNeeded(workspaceId);
  const plan = await getEffectivePlan(workspaceId);
  const cost = CREDIT_COSTS[action];

  if (workspace.generationPaused) {
    logCreditDenial(workspaceId, userId, action, 'paused');
    return {
      ok: false,
      reason: 'paused',
      used: workspace.creditsUsed,
      limit: plan.monthlyCredits,
      message: creditDenialMessage('paused'),
    };
  }

  if (workspace.creditsUsed + cost > plan.monthlyCredits) {
    logCreditDenial(workspaceId, userId, action, 'workspace_exhausted');
    return {
      ok: false,
      reason: 'workspace_exhausted',
      used: workspace.creditsUsed,
      limit: plan.monthlyCredits,
      message: creditDenialMessage('workspace_exhausted'),
    };
  }

  if (workspace.memberMonthlyCreditCap != null) {
    const memberUsed = await prisma.creditLedger.aggregate({
      where: {
        workspaceId: workspace.id,
        userId,
        createdAt: { gte: workspace.creditsPeriodStart },
      },
      _sum: { credits: true },
    });
    const used = memberUsed._sum.credits ?? 0;
    if (used + cost > workspace.memberMonthlyCreditCap) {
      logCreditDenial(workspaceId, userId, action, 'member_cap');
      return {
        ok: false,
        reason: 'member_cap',
        used,
        limit: workspace.memberMonthlyCreditCap,
        message: creditDenialMessage('member_cap'),
      };
    }
  }

  return { ok: true, cost };
}

export class CreditLimitError extends Error {
  readonly reason = 'workspace_exhausted' as const;
  constructor(message = creditDenialMessage('workspace_exhausted')) {
    super(message);
    this.name = 'CreditLimitError';
  }
}

export async function consumeCredits(
  workspaceId: string,
  userId: string,
  action: CreditAction,
  projectId?: string | null,
) {
  const cost = CREDIT_COSTS[action];
  const plan = await getEffectivePlan(workspaceId);
  const result = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE "Workspace"
      SET "creditsUsed" = "creditsUsed" + ${cost}
      WHERE id = ${workspaceId}
        AND (
          ${plan.monthlyCredits} = -1
          OR "creditsUsed" + ${cost} <= ${plan.monthlyCredits}
        )
      RETURNING id
    `;
    if (!rows[0]) {
      throw new CreditLimitError();
    }
    await tx.creditLedger.create({
      data: {
        workspaceId,
        userId,
        projectId: projectId || null,
        action,
        credits: cost,
      },
    });
    return tx.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  });

  const crossed80 =
    plan.monthlyCredits > 0 &&
    result.creditsUsed >= Math.ceil(plan.monthlyCredits * 0.8) &&
    result.creditsUsed - cost < Math.ceil(plan.monthlyCredits * 0.8);
  if (crossed80) {
    // Claim the alert in the same statement that reads the flag, so two concurrent
    // consumes cannot both email the admins.
    const claimed = await prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "Workspace"
      SET "creditAlert80Sent" = true
      WHERE id = ${workspaceId}
        AND "creditAlert80Sent" = false
      RETURNING id
    `;
    if (claimed.length > 0) {
      await notifyAdminsCredit80({
        workspaceId,
        used: result.creditsUsed,
        limit: plan.monthlyCredits,
        periodStart: result.creditsPeriodStart,
      });
    }
  }

  return result;
}

async function currentForLimit(workspaceId: string, kind: LimitKind) {
  switch (kind) {
    case 'projects':
      return prisma.project.count({ where: { deletedAt: null } });
    case 'liveSites':
      return prisma.deployment.count({
        where: { workspaceId, kind: 'LIVE', status: { not: 'STOPPED' } },
      });
    case 'previewSites':
      return prisma.deployment.count({
        where: { workspaceId, kind: 'PREVIEW', status: { not: 'STOPPED' } },
      });
    case 'members':
      return prisma.user.count({ where: { isActive: true } });
    case 'sandboxes':
      return prisma.project.count({
        where: { deletedAt: null, sandboxStatus: { in: ['READY', 'BOOTING'] } },
      });
    case 'storage': {
      const workspace = await ensureWorkspace(workspaceId);
      return workspace.storageBytes;
    }
    default:
      return 0;
  }
}

function planLimit(plan: Plan, kind: LimitKind) {
  switch (kind) {
    case 'projects':
      return plan.maxProjects;
    case 'liveSites':
      return plan.maxLiveSites;
    case 'previewSites':
      return plan.maxPreviewSites;
    case 'members':
      return plan.maxMembers;
    case 'sandboxes':
      return plan.maxConcurrentSandboxes;
    case 'storage':
      return Number(plan.storageBytesLimit);
    default:
      return 0;
  }
}

export async function checkLimit(
  workspaceId: string,
  kind: LimitKind,
  upcoming = 0,
): Promise<LimitCheckResult> {
  const plan = await getEffectivePlan(workspaceId);
  const limit = planLimit(plan, kind);
  const current = await currentForLimit(workspaceId, kind);
  if (isUnlimited(limit) || current + upcoming <= limit) {
    return { ok: true, current, limit };
  }
  return {
    ok: false,
    current,
    limit,
    reason: kind,
    message: limitDenialMessage(kind),
  };
}

export const CUSTOM_DOMAIN_LOCKED_MESSAGE = 'This feature is not on your plan yet';

export async function checkCustomDomainAllowed(workspaceId: string) {
  const plan = await getEffectivePlan(workspaceId);
  if (!plan.allowCustomDomain) {
    return {
      ok: false as const,
      status: 402 as const,
      message: CUSTOM_DOMAIN_LOCKED_MESSAGE,
    };
  }
  return { ok: true as const, plan };
}
