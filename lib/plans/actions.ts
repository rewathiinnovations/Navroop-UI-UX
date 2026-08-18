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
  maxConcurrentSandboxes: number;
  checkpointRetentionDays: number;
  storageBytesLimit: bigint;
  allowCustomDomain: boolean;
  allowGithubSync: boolean;
  maxTokensPerJob?: number;
  maxFilesPerJob?: number;
  maxOutputBytesPerJob?: number;
  monthlySandboxMinutes?: number;
}): PublicPlan {
  return {
    ...plan,
    storageBytesLimit: plan.storageBytesLimit.toString(),
    maxTokensPerJob: plan.maxTokensPerJob ?? 120000,
    maxFilesPerJob: plan.maxFilesPerJob ?? 60,
    maxOutputBytesPerJob: plan.maxOutputBytesPerJob ?? 2000000,
    monthlySandboxMinutes: plan.monthlySandboxMinutes ?? 300,
  };
}

async function adminGate() {
  const result = await requireAdmin();
  if (!result.user) {
    return { user: null, err: { ok: false as const, error: result.error, status: result.status } };
  }
  return { user: result.user, err: null };
}

async function hydratePlanCaps() {
  const all = await prisma.$queryRaw<
    Array<{
      id: string;
      maxTokensPerJob: number;
      maxFilesPerJob: number;
      maxOutputBytesPerJob: number;
      monthlySandboxMinutes: number;
    }>
  >`SELECT id, "maxTokensPerJob", "maxFilesPerJob", "maxOutputBytesPerJob", "monthlySandboxMinutes" FROM "Plan"`;
  return new Map(all.map((row) => [row.id, row]));
}

export async function listPlans(): Promise<ActionOk<{ plans: PublicPlan[] }> | ActionErr> {
  const { err } = await adminGate();
  if (err) return err;
  const plans = await prisma.plan.findMany({ orderBy: { createdAt: 'asc' } });
  const caps = await hydratePlanCaps();
  return {
    ok: true,
    data: {
      plans: plans.map((plan) => toPublicPlan({ ...plan, ...caps.get(plan.id) })),
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
  maxConcurrentSandboxes: number;
  checkpointRetentionDays: number;
  storageBytesLimit: string | number;
  allowCustomDomain?: boolean;
  allowGithubSync?: boolean;
  isActive?: boolean;
  maxTokensPerJob?: number;
  maxFilesPerJob?: number;
  maxOutputBytesPerJob?: number;
  monthlySandboxMinutes?: number;
}): Promise<ActionOk<PublicPlan> | ActionErr> {
  const { err } = await adminGate();
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
      maxConcurrentSandboxes: input.maxConcurrentSandboxes,
      checkpointRetentionDays: input.checkpointRetentionDays,
      storageBytesLimit: BigInt(input.storageBytesLimit),
      allowCustomDomain: input.allowCustomDomain === true,
      allowGithubSync: input.allowGithubSync === true,
      isActive: input.isActive !== false,
      isDefault: false,
    },
  });
  await prisma.$executeRaw`
    UPDATE "Plan"
    SET
      "maxTokensPerJob" = ${input.maxTokensPerJob ?? 120000},
      "maxFilesPerJob" = ${input.maxFilesPerJob ?? 60},
      "maxOutputBytesPerJob" = ${input.maxOutputBytesPerJob ?? 2000000},
      "monthlySandboxMinutes" = ${input.monthlySandboxMinutes ?? 300}
    WHERE id = ${created.id}
  `;
  return { ok: true, data: toPublicPlan({
    ...created,
    maxTokensPerJob: input.maxTokensPerJob ?? 120000,
    maxFilesPerJob: input.maxFilesPerJob ?? 60,
    maxOutputBytesPerJob: input.maxOutputBytesPerJob ?? 2000000,
    monthlySandboxMinutes: input.monthlySandboxMinutes ?? 300,
  }) };
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
    maxConcurrentSandboxes: number;
    checkpointRetentionDays: number;
    storageBytesLimit: string | number;
    allowCustomDomain: boolean;
    allowGithubSync: boolean;
    maxTokensPerJob: number;
    maxFilesPerJob: number;
    maxOutputBytesPerJob: number;
    monthlySandboxMinutes: number;
  }>,
): Promise<ActionOk<PublicPlan> | ActionErr> {
  const { user, err } = await adminGate();
  if (err) return err;
  const existing = await prisma.plan.findUnique({ where: { id } });
  if (!existing) return { ok: false, error: 'Plan not found', status: 404 };

  if (input.isDefault === true) {
    await prisma.$transaction([
      prisma.plan.updateMany({ where: { isDefault: true }, data: { isDefault: false } }),
      prisma.plan.update({
        where: { id },
        data: {
          isDefault: true,
          isActive: true,
        },
      }),
    ]);
  }

  const updated = await prisma.plan.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.monthlyCredits !== undefined ? { monthlyCredits: input.monthlyCredits } : {}),
      ...(input.maxProjects !== undefined ? { maxProjects: input.maxProjects } : {}),
      ...(input.maxLiveSites !== undefined ? { maxLiveSites: input.maxLiveSites } : {}),
      ...(input.maxPreviewSites !== undefined ? { maxPreviewSites: input.maxPreviewSites } : {}),
      ...(input.maxMembers !== undefined ? { maxMembers: input.maxMembers } : {}),
      ...(input.maxConcurrentSandboxes !== undefined
        ? { maxConcurrentSandboxes: input.maxConcurrentSandboxes }
        : {}),
      ...(input.checkpointRetentionDays !== undefined
        ? { checkpointRetentionDays: input.checkpointRetentionDays }
        : {}),
      ...(input.storageBytesLimit !== undefined
        ? { storageBytesLimit: BigInt(input.storageBytesLimit) }
        : {}),
      ...(input.allowCustomDomain !== undefined ? { allowCustomDomain: input.allowCustomDomain } : {}),
      ...(input.allowGithubSync !== undefined ? { allowGithubSync: input.allowGithubSync } : {}),
    },
  });
  if (
    input.maxTokensPerJob !== undefined ||
    input.maxFilesPerJob !== undefined ||
    input.maxOutputBytesPerJob !== undefined ||
    input.monthlySandboxMinutes !== undefined
  ) {
    await prisma.$executeRaw`
      UPDATE "Plan"
      SET
        "maxTokensPerJob" = COALESCE(${input.maxTokensPerJob ?? null}, "maxTokensPerJob"),
        "maxFilesPerJob" = COALESCE(${input.maxFilesPerJob ?? null}, "maxFilesPerJob"),
        "maxOutputBytesPerJob" = COALESCE(${input.maxOutputBytesPerJob ?? null}, "maxOutputBytesPerJob"),
        "monthlySandboxMinutes" = COALESCE(${input.monthlySandboxMinutes ?? null}, "monthlySandboxMinutes")
      WHERE id = ${id}
    `;
  }
  const publicPlan = toPublicPlan({
    ...updated,
    maxTokensPerJob: input.maxTokensPerJob,
    maxFilesPerJob: input.maxFilesPerJob,
    maxOutputBytesPerJob: input.maxOutputBytesPerJob,
    monthlySandboxMinutes: input.monthlySandboxMinutes,
  });
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

export async function assignDefaultWorkspacePlan(planId: string): Promise<ActionOk<{ planId: string }> | ActionErr> {
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
    return { ok: false, error: error instanceof Error ? error.message : 'Could not assign plan', status: 400 };
  }
}

export async function getWorkspaceAdminSettings(): Promise<
  ActionOk<{
    memberMonthlyCreditCap: number | null;
    generationPaused: boolean;
    pauseReason: string | null;
    planId: string | null;
    creditAlert80Sent: boolean;
    monthlySpendLimitUsd: number | null;
    spendUsd: number;
  }> | ActionErr
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
      monthlySpendLimitUsd: extra[0]?.monthlySpendLimitUsd == null ? null : Number(extra[0].monthlySpendLimitUsd),
      spendUsd: Number(extra[0]?.spendUsd ?? 0),
    },
  };
}

export async function updateWorkspaceAdminSettings(input: {
  memberMonthlyCreditCap?: number | null;
  generationPaused?: boolean;
  monthlySpendLimitUsd?: number | null;
}): Promise<
  ActionOk<{
    memberMonthlyCreditCap: number | null;
    generationPaused: boolean;
    pauseReason: string | null;
    monthlySpendLimitUsd: number | null;
    spendUsd: number;
  }> | ActionErr
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
      monthlySpendLimitUsd: extra[0]?.monthlySpendLimitUsd == null ? null : Number(extra[0].monthlySpendLimitUsd),
      spendUsd: Number(extra[0]?.spendUsd ?? 0),
    },
  };
}

export async function getCreditMeter() {
  const user = await getSessionUser();
  if (!user) return { ok: false as const, error: 'Sign in required', status: 401 as const };
  const workspace = await rollCreditPeriodIfNeeded();
  const plan = await getEffectivePlan();
  const extra = await prisma.$queryRaw<
    Array<{ sandboxMinutesUsed: number; monthlySandboxMinutes: number }>
  >`
    SELECT w."sandboxMinutesUsed", COALESCE(p."monthlySandboxMinutes", 300) AS "monthlySandboxMinutes"
    FROM "Workspace" w
    LEFT JOIN "Plan" p ON p.id = ${plan.id}
    WHERE w.id = ${workspace.id}
    LIMIT 1
  `;
  return {
    ok: true as const,
    data: {
      used: workspace.creditsUsed,
      limit: plan.monthlyCredits,
      resetAt: addMonthIso(workspace.creditsPeriodStart),
      paused: workspace.generationPaused,
      sandboxMinutesUsed: extra[0]?.sandboxMinutesUsed ?? 0,
      sandboxMinutesLimit: extra[0]?.monthlySandboxMinutes ?? 300,
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

  const ledgers = await prisma.creditLedger.findMany({
    where: {
      workspaceId: workspace.id,
      createdAt: { gte: workspace.creditsPeriodStart },
    },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: 'desc' },
  });

  const byAction: Record<string, number> = {};
  const byMember = new Map<
    string,
    { userId: string; name: string; email: string; credits: number; actions: Record<string, number> }
  >();
  for (const row of ledgers) {
    byAction[row.action] = (byAction[row.action] ?? 0) + row.credits;
    const current = byMember.get(row.userId) ?? {
      userId: row.userId,
      name: row.user.name,
      email: row.user.email,
      credits: 0,
      actions: {},
    };
    current.credits += row.credits;
    current.actions[row.action] = (current.actions[row.action] ?? 0) + row.credits;
    byMember.set(row.userId, current);
  }

  const totals = await prisma.creditLedger.aggregate({
    where: { workspaceId: workspace.id, createdAt: { gte: workspace.creditsPeriodStart } },
    _sum: { credits: true },
  });

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
      workspaceTotal: totals._sum.credits ?? workspace.creditsUsed,
      isAdmin,
      sandboxMinutesUsed: (
        await prisma.$queryRaw<Array<{ sandboxMinutesUsed: number }>>`
          SELECT "sandboxMinutesUsed" FROM "Workspace" WHERE id = ${workspace.id} LIMIT 1
        `
      )[0]?.sandboxMinutesUsed ?? 0,
      sandboxMinutesLimit: (
        await prisma.$queryRaw<Array<{ monthlySandboxMinutes: number }>>`
          SELECT "monthlySandboxMinutes" FROM "Plan" WHERE id = ${plan.id} LIMIT 1
        `
      )[0]?.monthlySandboxMinutes ?? 300,
    },
  };
}
