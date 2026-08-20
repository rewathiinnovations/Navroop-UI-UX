'use server';

import { prisma } from '@/lib/db';
import { requireAdmin, getSessionUser } from '@/lib/auth';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { writeAudit } from '@/lib/audit/log';
import { assignWorkspacePlan } from './billing';
import { ensureWorkspace, getEffectivePlan, rollCreditPeriodIfNeeded } from './limits';
import type { PublicPlan } from './types';

type ActionErr = { ok: false; error: string; status: number };
type ActionOk<T> = { ok: true; data: T };

function toPublicPlan(plan: {
  id: string;
  key: string;
  name: string;
  isActive: boolean;
  isDefault: boolean;
  monthlyCredits: number;
  maxProjects: number;
  maxLiveSites: number;
  maxPreviewSites: number;
  maxMembers: number;
  checkpointRetentionDays: number;
  storageBytesLimit: bigint;
  allowCustomDomain: boolean;
  allowGithubSync: boolean;
  maxTokensPerJob: number;
  maxFilesPerJob: number;
  maxOutputBytesPerJob: number;
}): PublicPlan {
  return {
    ...plan,
    storageBytesLimit: plan.storageBytesLimit.toString(),
  };
}

async function adminGate() {
  const result = await requireAdmin();
  if (!result.user) {
    return { user: null, err: { ok: false as const, error: result.error, status: result.status } };
  }
  return { user: result.user, err: null };
}

export async function listPlans(): Promise<ActionOk<{ plans: PublicPlan[] }> | ActionErr> {
  const { err } = await adminGate();
  if (err) return err;
  const plans = await prisma.plan.findMany({ orderBy: { createdAt: 'asc' } });
  return {
    ok: true,
    data: {
      plans: plans.map(toPublicPlan),
    },
  };
}

export async function createPlan(input: {
  key: string;
  name: string;
  monthlyCredits: number;
  maxProjects: number;
  maxLiveSites: number;
  maxPreviewSites: number;
  maxMembers: number;
  checkpointRetentionDays: number;
  storageBytesLimit: string | number;
  allowCustomDomain?: boolean;
  allowGithubSync?: boolean;
  isActive?: boolean;
  maxTokensPerJob?: number;
  maxFilesPerJob?: number;
  maxOutputBytesPerJob?: number;
}): Promise<ActionOk<PublicPlan> | ActionErr> {
  const { user, err } = await adminGate();
  if (err) return err;
  const key = input.key.trim().toLowerCase();
  if (!key) return { ok: false, error: 'Plan key is required', status: 400 };
  const created = await prisma.plan.create({
    data: {
      key,
      name: input.name.trim() || key,
      monthlyCredits: input.monthlyCredits,
      maxProjects: input.maxProjects,
      maxLiveSites: input.maxLiveSites,
      maxPreviewSites: input.maxPreviewSites,
      maxMembers: input.maxMembers,
      checkpointRetentionDays: input.checkpointRetentionDays,
      storageBytesLimit: BigInt(input.storageBytesLimit),
      allowCustomDomain: input.allowCustomDomain === true,
      allowGithubSync: input.allowGithubSync === true,
      isActive: input.isActive !== false,
      isDefault: false,
      // These three used to be written by a follow-up `$executeRaw` because the
      // generated client predated the columns. The raw statement carried a
      // trailing comma before its WHERE, so every create inserted the row and
      // then threw `syntax error at or near "WHERE"`: the admin got a 500 and a
      // plan that only appeared after a refresh. They are ordinary Prisma
      // fields, so they belong in the same insert as everything else.
      ...(input.maxTokensPerJob !== undefined ? { maxTokensPerJob: input.maxTokensPerJob } : {}),
      ...(input.maxFilesPerJob !== undefined ? { maxFilesPerJob: input.maxFilesPerJob } : {}),
      ...(input.maxOutputBytesPerJob !== undefined
        ? { maxOutputBytesPerJob: input.maxOutputBytesPerJob }
        : {}),
    },
  });
  // A plan defines credit ceilings, project/site/member limits and per-job token
  // caps. Editing one and assigning one were both audited; creating one was not,
  // so /admin/audit could show a limit set being changed and put into service
  // with no record of how it came to exist (F-316).
  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: 'plan.create',
    targetType: 'plan',
    targetId: created.id,
    after: {
      key: created.key,
      monthlyCredits: created.monthlyCredits,
      maxProjects: created.maxProjects,
      maxLiveSites: created.maxLiveSites,
      maxPreviewSites: created.maxPreviewSites,
      maxMembers: created.maxMembers,
      storageBytesLimit: created.storageBytesLimit.toString(),
      isActive: created.isActive,
    },
  });
  return { ok: true, data: toPublicPlan(created) };
}

export async function updatePlan(
  id: string,
  input: Partial<{
    name: string;
    isActive: boolean;
    isDefault: boolean;
    monthlyCredits: number;
    maxProjects: number;
    maxLiveSites: number;
    maxPreviewSites: number;
    maxMembers: number;
    checkpointRetentionDays: number;
    storageBytesLimit: string | number;
    allowCustomDomain: boolean;
    allowGithubSync: boolean;
    maxTokensPerJob: number;
    maxFilesPerJob: number;
    maxOutputBytesPerJob: number;
  }>,
): Promise<ActionOk<PublicPlan> | ActionErr> {
  const { user, err } = await adminGate();
  if (err) return err;
  const existing = await prisma.plan.findUnique({ where: { id } });
  if (!existing) return { ok: false, error: 'Plan not found', status: 404 };

  // The default plan is what `getEffectivePlan` falls back to, and its fallback query is
  // `where: { isDefault: true }` with no `isActive` filter. So switching the default off
  // does not remove it from service — it silently becomes an inactive plan that every
  // limit and credit check is evaluated against. Refusing is the clearer contract than
  // filtering the fallback, because the operator asked for something that cannot mean
  // what they think it means.
  const willBeDefault = input.isDefault === true || existing.isDefault;
  if (input.isActive === false && willBeDefault) {
    return {
      ok: false,
      error: 'The default plan cannot be switched off — make another plan the default first',
      status: 400,
    };
  }

  // One transaction, not two writes (F-312). The `isDefault` demotion of the siblings used
  // to commit on its own and the rest of the payload followed in an independent `update`:
  // a failure in between moved the default while none of the operator's other edits
  // landed, with no compensation, and the second write's `isActive: input.isActive`
  // overwrote the `true` the first had just set.
  const updated = await prisma.$transaction(async (tx) => {
    if (input.isDefault === true) {
      await tx.plan.updateMany({
        where: { isDefault: true, id: { not: id } },
        data: { isDefault: false },
      });
    }
    return tx.plan.update({
      where: { id },
      data: {
        ...(input.isDefault === true ? { isDefault: true, isActive: true } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.monthlyCredits !== undefined ? { monthlyCredits: input.monthlyCredits } : {}),
        ...(input.maxProjects !== undefined ? { maxProjects: input.maxProjects } : {}),
        ...(input.maxLiveSites !== undefined ? { maxLiveSites: input.maxLiveSites } : {}),
        ...(input.maxPreviewSites !== undefined ? { maxPreviewSites: input.maxPreviewSites } : {}),
        ...(input.maxMembers !== undefined ? { maxMembers: input.maxMembers } : {}),
        ...(input.checkpointRetentionDays !== undefined
          ? { checkpointRetentionDays: input.checkpointRetentionDays }
          : {}),
        ...(input.storageBytesLimit !== undefined
          ? { storageBytesLimit: BigInt(input.storageBytesLimit) }
          : {}),
        ...(input.allowCustomDomain !== undefined
          ? { allowCustomDomain: input.allowCustomDomain }
          : {}),
        ...(input.allowGithubSync !== undefined ? { allowGithubSync: input.allowGithubSync } : {}),
        ...(input.maxTokensPerJob !== undefined ? { maxTokensPerJob: input.maxTokensPerJob } : {}),
        ...(input.maxFilesPerJob !== undefined ? { maxFilesPerJob: input.maxFilesPerJob } : {}),
        ...(input.maxOutputBytesPerJob !== undefined
          ? { maxOutputBytesPerJob: input.maxOutputBytesPerJob }
          : {}),
      },
    });
  });
  // `updated` is the source of truth for the response. Echoing `input` here instead
  // reported the hardcoded defaults for whichever job cap the admin had not touched,
  // and PlansAdmin writes the response straight into local state — so editing Credits
  // silently told the operator that Tokens/job was 120000 when the row said 200000.
  const publicPlan = toPublicPlan(updated);
  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: 'plan.limits_edit',
    targetType: 'plan',
    targetId: id,
    before: {
      monthlyCredits: existing.monthlyCredits,
      maxProjects: existing.maxProjects,
      maxLiveSites: existing.maxLiveSites,
      maxPreviewSites: existing.maxPreviewSites,
    },
    after: {
      monthlyCredits: updated.monthlyCredits,
      maxProjects: updated.maxProjects,
      maxLiveSites: updated.maxLiveSites,
      maxPreviewSites: updated.maxPreviewSites,
    },
  });
  return { ok: true, data: publicPlan };
}

export async function assignDefaultWorkspacePlan(
  planId: string,
): Promise<ActionOk<{ planId: string }> | ActionErr> {
  const { user, err } = await adminGate();
  if (err) return err;
  try {
    const before = await prisma.workspace.findUnique({
      where: { id: WORKSPACE_ROW_ID },
      select: { planId: true },
    });
    await assignWorkspacePlan(WORKSPACE_ROW_ID, planId);
    await writeAudit({
      actorId: user.id,
      actorEmail: user.email,
      action: 'plan.assign',
      targetType: 'workspace',
      targetId: WORKSPACE_ROW_ID,
      before: { planId: before?.planId ?? null },
      after: { planId },
    });
    return { ok: true, data: { planId } };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not assign plan',
      status: 400,
    };
  }
}

export async function getWorkspaceAdminSettings(): Promise<
  | ActionOk<{
      memberMonthlyCreditCap: number | null;
      generationPaused: boolean;
      pauseReason: string | null;
      planId: string | null;
      creditAlert80Sent: boolean;
      monthlySpendLimitUsd: number | null;
      spendUsd: number;
    }>
  | ActionErr
> {
  const { err } = await adminGate();
  if (err) return err;
  const workspace = await ensureWorkspace();
  const extra = await prisma.$queryRaw<
    Array<{
      pauseReason: string | null;
      monthlySpendLimitUsd: unknown;
      spendUsd: unknown;
    }>
  >`
    SELECT "pauseReason", "monthlySpendLimitUsd", "spendUsd"
    FROM "Workspace"
    WHERE id = ${workspace.id}
    LIMIT 1
  `;
  return {
    ok: true,
    data: {
      memberMonthlyCreditCap: workspace.memberMonthlyCreditCap,
      generationPaused: workspace.generationPaused,
      pauseReason: extra[0]?.pauseReason ?? null,
      planId: workspace.planId,
      creditAlert80Sent: workspace.creditAlert80Sent,
      monthlySpendLimitUsd:
        extra[0]?.monthlySpendLimitUsd == null ? null : Number(extra[0].monthlySpendLimitUsd),
      spendUsd: Number(extra[0]?.spendUsd ?? 0),
    },
  };
}

export async function updateWorkspaceAdminSettings(input: {
  memberMonthlyCreditCap?: number | null;
  generationPaused?: boolean;
  monthlySpendLimitUsd?: number | null;
}): Promise<
  | ActionOk<{
      memberMonthlyCreditCap: number | null;
      generationPaused: boolean;
      pauseReason: string | null;
      monthlySpendLimitUsd: number | null;
      spendUsd: number;
    }>
  | ActionErr
> {
  const { user, err } = await adminGate();
  if (err) return err;
  await ensureWorkspace();
  const previous = await prisma.workspace.findUnique({
    where: { id: WORKSPACE_ROW_ID },
    select: { generationPaused: true },
  });
  const updated = await prisma.workspace.update({
    where: { id: WORKSPACE_ROW_ID },
    data: {
      ...(input.memberMonthlyCreditCap !== undefined
        ? { memberMonthlyCreditCap: input.memberMonthlyCreditCap }
        : {}),
      ...(input.generationPaused !== undefined ? { generationPaused: input.generationPaused } : {}),
    },
  });
  if (input.generationPaused === true) {
    await prisma.$executeRaw`
      UPDATE "Workspace" SET "pauseReason" = 'MANUAL' WHERE id = ${WORKSPACE_ROW_ID}
    `;
  } else if (input.generationPaused === false) {
    await prisma.$executeRaw`
      UPDATE "Workspace" SET "pauseReason" = NULL WHERE id = ${WORKSPACE_ROW_ID}
    `;
  }
  if (input.monthlySpendLimitUsd !== undefined) {
    await prisma.$executeRaw`
      UPDATE "Workspace"
      SET "monthlySpendLimitUsd" = ${input.monthlySpendLimitUsd}
      WHERE id = ${WORKSPACE_ROW_ID}
    `;
  }
  const extra = await prisma.$queryRaw<
    Array<{ pauseReason: string | null; monthlySpendLimitUsd: unknown; spendUsd: unknown }>
  >`
    SELECT "pauseReason", "monthlySpendLimitUsd", "spendUsd"
    FROM "Workspace" WHERE id = ${WORKSPACE_ROW_ID} LIMIT 1
  `;
  if (
    input.generationPaused !== undefined &&
    previous?.generationPaused !== updated.generationPaused
  ) {
    await writeAudit({
      actorId: user.id,
      actorEmail: user.email,
      action: 'workspace.generation_paused',
      targetType: 'workspace',
      targetId: WORKSPACE_ROW_ID,
      before: { generationPaused: previous?.generationPaused ?? false },
      after: { generationPaused: updated.generationPaused },
    });
  }
  return {
    ok: true,
    data: {
      memberMonthlyCreditCap: updated.memberMonthlyCreditCap,
      generationPaused: updated.generationPaused,
      pauseReason: extra[0]?.pauseReason ?? null,
      monthlySpendLimitUsd:
        extra[0]?.monthlySpendLimitUsd == null ? null : Number(extra[0].monthlySpendLimitUsd),
      spendUsd: Number(extra[0]?.spendUsd ?? 0),
    },
  };
}

export async function getCreditMeter() {
  const user = await getSessionUser();
  if (!user) return { ok: false as const, error: 'Sign in required', status: 401 as const };
  const workspace = await rollCreditPeriodIfNeeded();
  const plan = await getEffectivePlan();
  return {
    ok: true as const,
    data: {
      used: workspace.creditsUsed,
      limit: plan.monthlyCredits,
      resetAt: addMonthIso(workspace.creditsPeriodStart),
      paused: workspace.generationPaused,
    },
  };
}

function addMonthIso(start: Date) {
  const next = new Date(start.getTime());
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next.toISOString();
}

export async function getUsageBreakdown() {
  const user = await getSessionUser();
  if (!user) return { ok: false as const, error: 'Sign in required', status: 401 as const };

  const workspace = await rollCreditPeriodIfNeeded();
  const plan = await getEffectivePlan();
  const isAdmin = user.role === 'ADMIN';

  const period = {
    workspaceId: workspace.id,
    createdAt: { gte: workspace.creditsPeriodStart },
  };

  // Two grouped aggregates instead of every ledger row of the period with a joined user
  // (F-311). One row exists per credit-consuming action, so a busy month accumulates
  // thousands, and this route is reachable by any member as often as they like: the old
  // shape grew response time and server memory linearly with monthly activity and
  // duplicated the joined `user` object on every row. Postgres answers both shapes in a
  // handful of rows. The existing `CreditLedger(workspaceId, createdAt)` index serves both.
  const [actionGroups, memberGroups] = await Promise.all([
    prisma.creditLedger.groupBy({ by: ['action'], where: period, _sum: { credits: true } }),
    prisma.creditLedger.groupBy({
      by: ['userId', 'action'],
      where: period,
      _sum: { credits: true },
    }),
  ]);

  const byAction: Record<string, number> = {};
  for (const group of actionGroups) {
    byAction[group.action] = group._sum.credits ?? 0;
  }

  const memberIds = [...new Set(memberGroups.map((group) => group.userId))];
  const members = memberIds.length
    ? await prisma.user.findMany({
        where: { id: { in: memberIds } },
        select: { id: true, name: true, email: true },
      })
    : [];
  const memberById = new Map(members.map((row) => [row.id, row]));

  const byMember = new Map<
    string,
    {
      userId: string;
      name: string;
      email: string;
      credits: number;
      actions: Record<string, number>;
    }
  >();
  for (const group of memberGroups) {
    const member = memberById.get(group.userId);
    if (!member) continue;
    const credits = group._sum.credits ?? 0;
    const current = byMember.get(group.userId) ?? {
      userId: group.userId,
      name: member.name,
      email: member.email,
      credits: 0,
      actions: {},
    };
    current.credits += credits;
    current.actions[group.action] = credits;
    byMember.set(group.userId, current);
  }
  if (byMember.size !== memberIds.length) {
    // Unreachable while `CreditLedger.userId` is ON DELETE CASCADE — the `include: { user }`
    // this replaced relied on the same guarantee and would have thrown. If it ever fires,
    // the per-member breakdown is short by those credits while `workspaceTotal` still
    // counts them, so `unattributed` is where the difference surfaces.
    console.warn('[plans] credit ledger rows with no user row', {
      workspaceId: workspace.id,
      missing: memberIds.length - byMember.size,
    });
  }

  // The grouped sums already are the total. The separate `aggregate` scanned the period a
  // second time for a number that is the sum of `byAction`. `null` rather than 0 when the
  // period has no rows at all, so the `workspaceTotal` fallback below still distinguishes
  // "nothing recorded" from "recorded zero".
  const ledgerTotal = actionGroups.length
    ? actionGroups.reduce((sum, group) => sum + (group._sum.credits ?? 0), 0)
    : null;

  return {
    ok: true as const,
    data: {
      used: workspace.creditsUsed,
      limit: plan.monthlyCredits,
      resetAt: addMonthIso(workspace.creditsPeriodStart),
      storageBytes: workspace.storageBytes,
      storageLimitBytes: Number(plan.storageBytesLimit),
      byAction,
      members: [...byMember.values()].filter((row) => isAdmin || row.userId === user.id),
      workspaceTotal: ledgerTotal ?? workspace.creditsUsed,
      // The meter is the Workspace counter; the breakdown is the ledger. They
      // diverge legitimately — deleting a user cascades their ledger rows while
      // the counter keeps billing history. Showing the difference beats letting
      // the two numbers silently disagree.
      unattributed: Math.max(0, workspace.creditsUsed - (ledgerTotal ?? 0)),
      isAdmin,
    },
  };
}
