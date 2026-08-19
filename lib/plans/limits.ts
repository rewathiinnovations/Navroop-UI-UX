import type { Plan, Workspace } from '@/generated/prisma';
import { prisma } from '@/lib/db';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { notifyAdminsCredit80 } from './alerts';
import { creditDenialMessage, limitDenialMessage } from './messages';
import { log } from '@/lib/logger';
import { trackFailure } from '@/lib/observability/track';
import { setSentryActionContext } from '@/lib/sentry/context';
import type {
  CreditAction,
  CreditCheckResult,
  CreditDenialReason,
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
      "spendUsd" = 0,
      "spendAlert80Sent" = false,
      "generationPaused" = CASE WHEN "pauseReason" = 'SPEND_LIMIT' THEN false ELSE "generationPaused" END,
      "pauseReason" = CASE WHEN "pauseReason" = 'SPEND_LIMIT' THEN NULL ELSE "pauseReason" END
    WHERE id = ${workspace.id}
  `;
  return prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
}

function logCreditDenial(
  workspaceId: string,
  userId: string,
  action: CreditAction,
  reason: string,
) {
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

  // `isUnlimited` is the only place the -1 convention is spelled out; re-deriving it
  // here is what let an "unlimited" plan deny every generation at 0 credits used,
  // because `0 + 1 > -1`. The write path in `consumeCredits` always honoured it.
  if (!isUnlimited(plan.monthlyCredits) && workspace.creditsUsed + cost > plan.monthlyCredits) {
    logCreditDenial(workspaceId, userId, action, 'workspace_exhausted');
    return {
      ok: false,
      reason: 'workspace_exhausted',
      used: workspace.creditsUsed,
      limit: plan.monthlyCredits,
      message: creditDenialMessage('workspace_exhausted'),
    };
  }

  // null means "no per-member cap"; -1 means "unlimited", same as every other limit.
  if (workspace.memberMonthlyCreditCap != null && !isUnlimited(workspace.memberMonthlyCreditCap)) {
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

/**
 * Reasons the authoritative debit can refuse. `paused` is deliberately absent: it is a
 * pre-flight-only reason, and `consumeCredits` never re-reads the pause flag.
 */
export type CreditLimitReason = Extract<CreditDenialReason, 'workspace_exhausted' | 'member_cap'>;

export class CreditLimitError extends Error {
  readonly reason: CreditLimitReason;
  constructor(
    reason: CreditLimitReason = 'workspace_exhausted',
    message = creditDenialMessage(reason),
  ) {
    super(message);
    this.name = 'CreditLimitError';
    this.reason = reason;
  }
}

export async function consumeCredits(
  workspaceId: string,
  userId: string,
  action: CreditAction,
  projectId?: string | null,
) {
  const cost = CREDIT_COSTS[action];
  // The debit rolls the period itself rather than trusting the caller to have pre-flighted.
  // Everything below reads period-scoped state — `creditsUsed` against the plan ceiling, the
  // member's ledger sum since `creditsPeriodStart`, the 80% flag — and the comment on the
  // member-cap check below exists precisely because a charge can arrive with no pre-flight
  // (a retry through `markJobRunning({ chargeCredits: true })`, a reaper re-run). Such a
  // charge against a stale period would count last month's ledger rows towards this month's
  // cap and refuse a legitimate build. `rollCreditPeriodIfNeeded` writes only when the
  // window has actually elapsed, so the common path costs one extra read.
  await rollCreditPeriodIfNeeded(workspaceId);
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
    const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    // The per-member cap used to be checked only by `checkCredits`, which reads the
    // ledger outside any transaction: two concurrent generations both read the same sum
    // and both passed, and any charge that skips the pre-flight — a job retry through
    // `markJobRunning({ chargeCredits: true })`, a reaper re-run — billed past the cap
    // with no check at all. Enforcing it here is atomic because the UPDATE above holds a
    // row lock on the workspace for the rest of the transaction, so a second consume
    // blocks until this one commits and only then reads the ledger. The ledger row is
    // already inserted, so the sum includes this charge.
    const cap = workspace.memberMonthlyCreditCap;
    if (cap != null && !isUnlimited(cap)) {
      const memberUsed = await tx.creditLedger.aggregate({
        where: {
          workspaceId,
          userId,
          createdAt: { gte: workspace.creditsPeriodStart },
        },
        _sum: { credits: true },
      });
      if ((memberUsed._sum.credits ?? 0) > cap) {
        throw new CreditLimitError('member_cap');
      }
    }
    return workspace;
  });

  // "At or past the threshold and not yet claimed", not "the instant of crossing". The old
  // condition also required `creditsUsed - cost < threshold`, which is true on exactly one
  // debit per period — so the try/catch below turned "the alert failed loudly" into "the
  // alert never happens again this period": the flag stayed false, the edge never recurred,
  // and the workspace sailed past 80% with nothing shown at /admin/workspace until
  // `rollCreditPeriodIfNeeded` reset the period. The conditional claim UPDATE is the
  // idempotency guard, so re-evaluating on every debit above the threshold is safe and
  // costs one UPDATE that matches no row.
  const alertDue =
    plan.monthlyCredits > 0 &&
    result.creditsUsed >= Math.ceil(plan.monthlyCredits * 0.8) &&
    !result.creditAlert80Sent;
  if (alertDue) {
    // The alert stays outside the transaction on purpose — a failed email must never roll
    // back a good debit — but that also means a throw from here reaches
    // `chargeJobCreditsOnce`, which reads any throw as "the charge failed", nulls
    // `creditsChargedAt` and fails the job. The workspace was already debited, so the retry
    // charged a second time and `creditsUsed` drifted above the ledger for good. Contained
    // and logged, never rethrown.
    let unsentClaim = false;
    try {
      // Claim the alert in the same statement that reads the flag, so two concurrent
      // consumes cannot both raise it. `notifyAdminsCredit80` writes the receipt
      // /admin/workspace reads, so a double claim would be a duplicate receipt.
      const claimed = await prisma.$queryRaw<Array<{ id: string }>>`
        UPDATE "Workspace"
        SET "creditAlert80Sent" = true
        WHERE id = ${workspaceId}
          AND "creditAlert80Sent" = false
        RETURNING id
      `;
      unsentClaim = claimed.length > 0;
      if (unsentClaim) {
        const sent = await notifyAdminsCredit80({
          workspaceId,
          used: result.creditsUsed,
          limit: plan.monthlyCredits,
          periodStart: result.creditsPeriodStart,
        });
        unsentClaim = !sent;
      }
    } catch (error) {
      // `trackFailure`, not `logError`: nothing else surfaces this. `logError` reaches
      // container stdout only — no Sentry integration reads console — so an operator's
      // only clue that the 80% warning was dropped would be grepping for an event name
      // nobody has been told to grep for.
      trackFailure('credits.alert_failed', error, { workspaceId, userId, action });
    }
    if (unsentClaim) {
      // The flag is a receipt for an alert that never went out, and nothing else re-sends
      // it — `consumeCredits` is the only sender. Hand the claim back so the next debit
      // above the threshold tries again. No condition needed: the claim above won the
      // false -> true race, so no concurrent consume can be holding it.
      try {
        await prisma.workspace.update({
          where: { id: workspaceId },
          data: { creditAlert80Sent: false },
        });
      } catch (error) {
        // Worse than a dropped alert: the flag now says "sent" for an alert that never
        // went out, and only the period roll clears it.
        trackFailure('credits.alert_claim_stuck', error, { workspaceId, userId, action });
      }
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
