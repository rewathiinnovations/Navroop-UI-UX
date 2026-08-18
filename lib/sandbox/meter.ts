import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';
import { getEffectivePlan, isUnlimited, rollCreditPeriodIfNeeded } from '@/lib/plans/limits';
import { accrueSandboxSpend } from '@/lib/plans/spend';
import {
  SANDBOX_MINUTES_EXHAUSTED,
  canColdStartSandbox,
  sandboxMinutesBetween,
} from './minutes';

export async function readSandboxMinutesUsed(workspaceId: string) {
  const rows = await prisma.$queryRaw<Array<{ sandboxMinutesUsed: number }>>`
    SELECT "sandboxMinutesUsed" FROM "Workspace" WHERE id = ${workspaceId} LIMIT 1
  `;
  return rows[0]?.sandboxMinutesUsed ?? 0;
}

export async function readMonthlySandboxMinutes(planId: string) {
  const rows = await prisma.$queryRaw<Array<{ monthlySandboxMinutes: number }>>`
    SELECT "monthlySandboxMinutes" FROM "Plan" WHERE id = ${planId} LIMIT 1
  `;
  return rows[0]?.monthlySandboxMinutes ?? 300;
}

export async function accrueSandboxMinutes(workspaceId: string, minutes: number) {
  const add = Math.max(0, Math.floor(minutes));
  if (add <= 0) return { sandboxMinutesUsed: await readSandboxMinutesUsed(workspaceId) };
  await prisma.$executeRaw`
    UPDATE "Workspace"
    SET "sandboxMinutesUsed" = COALESCE("sandboxMinutesUsed", 0) + ${add}
    WHERE id = ${workspaceId}
  `;
  await accrueSandboxSpend(workspaceId, add).catch((error) => {
    log.error('sandbox.spend_accrual_failed', {
      workspaceId,
      minutes: add,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return { sandboxMinutesUsed: await readSandboxMinutesUsed(workspaceId) };
}

export async function checkSandboxMinutes(workspaceId: string) {
  await rollCreditPeriodIfNeeded(workspaceId);
  const plan = await getEffectivePlan(workspaceId);
  const used = await readSandboxMinutesUsed(workspaceId);
  const limit = await readMonthlySandboxMinutes(plan.id);
  if (isUnlimited(limit) || canColdStartSandbox(used, limit)) {
    return { ok: true as const, used, limit };
  }
  return {
    ok: false as const,
    used,
    limit,
    message: SANDBOX_MINUTES_EXHAUSTED,
  };
}

export async function accrueProjectSandboxMinutes(
  projectId: string,
  workspaceId: string,
  endedAt = new Date(),
  opts: { bumpStart?: boolean } = {},
) {
  const rows = await prisma.$queryRaw<
    Array<{ sandboxStartedAt: Date | null; sandboxMeteredUntil: Date | null }>
  >`
    SELECT "sandboxStartedAt", "sandboxMeteredUntil"
    FROM "Project"
    WHERE id = ${projectId}
    LIMIT 1
  `;
  const row = rows[0];
  const from = row?.sandboxMeteredUntil ?? row?.sandboxStartedAt;
  if (!from) return { minutes: 0 };
  const minutes = sandboxMinutesBetween(new Date(from), endedAt);
  if (minutes > 0) {
    await accrueSandboxMinutes(workspaceId, minutes);
  }
  if (opts.bumpStart) {
    await prisma.$executeRaw`
      UPDATE "Project"
      SET "sandboxMeteredUntil" = ${endedAt}
      WHERE id = ${projectId}
    `;
  }
  return { minutes };
}
