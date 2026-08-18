import { prisma } from '@/lib/db';
import { notifyAdminsSpend80, notifyAdminsSpendLimit } from './alerts';
import { estimateSandboxCostUsd } from '@/lib/consumption/cost';

export const PAUSE_REASON_AUTOMATIC = 'Automatic pause';
export const PAUSE_REASON_MANUAL = 'Manual pause';
export type PauseReason = 'SPEND_LIMIT' | 'MANUAL';

export function pauseReasonLabel(reason: string | null | undefined) {
  if (reason === 'SPEND_LIMIT') return PAUSE_REASON_AUTOMATIC;
  if (reason === 'MANUAL') return PAUSE_REASON_MANUAL;
  return '';
}

export function shouldNotifySpend80(
  spendUsd: number,
  limitUsd: number | null | undefined,
  alreadySent: boolean,
) {
  if (alreadySent || limitUsd == null || limitUsd <= 0) return false;
  return spendUsd >= limitUsd * 0.8;
}

export function shouldAutoPauseSpend(spendUsd: number, limitUsd: number | null | undefined) {
  if (limitUsd == null || limitUsd <= 0) return false;
  return spendUsd >= limitUsd;
}

export type WorkspaceSpendRow = {
  spendUsd: number;
  monthlySpendLimitUsd: number | null;
  spendAlert80Sent: boolean;
  generationPaused: boolean;
  pauseReason: string | null;
};

export async function readWorkspaceSpend(workspaceId: string): Promise<WorkspaceSpendRow | null> {
  const rows = await prisma.$queryRaw<
    Array<{
      spendUsd: unknown;
      monthlySpendLimitUsd: unknown;
      spendAlert80Sent: boolean;
      generationPaused: boolean;
      pauseReason: string | null;
    }>
  >`
    SELECT "spendUsd", "monthlySpendLimitUsd", "spendAlert80Sent", "generationPaused", "pauseReason"
    FROM "Workspace"
    WHERE id = ${workspaceId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    spendUsd: Number(row.spendUsd ?? 0),
    monthlySpendLimitUsd: row.monthlySpendLimitUsd == null ? null : Number(row.monthlySpendLimitUsd),
    spendAlert80Sent: Boolean(row.spendAlert80Sent),
    generationPaused: Boolean(row.generationPaused),
    pauseReason: row.pauseReason,
  };
}

export async function accrueSpend(workspaceId: string, usd: number) {
  const amount = Math.max(0, Number(usd) || 0);
  if (amount > 0) {
    await prisma.$executeRaw`
      UPDATE "Workspace"
      SET "spendUsd" = COALESCE("spendUsd", 0) + ${amount}
      WHERE id = ${workspaceId}
    `;
  }
  const row = await readWorkspaceSpend(workspaceId);
  if (!row) {
    return {
      spendUsd: 0,
      generationPaused: false,
      pauseReason: null as string | null,
    };
  }

  if (shouldNotifySpend80(row.spendUsd, row.monthlySpendLimitUsd, row.spendAlert80Sent)) {
    // Claim the flag in the same statement that reads it — two concurrent accruals
    // otherwise both pass the read and both email the admins.
    const claimed = await prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "Workspace"
      SET "spendAlert80Sent" = true
      WHERE id = ${workspaceId}
        AND "spendAlert80Sent" = false
      RETURNING id
    `;
    if (claimed.length > 0) {
      await notifyAdminsSpend80({
        workspaceId,
        used: row.spendUsd,
        limit: row.monthlySpendLimitUsd ?? 0,
      });
    }
  }

  if (
    shouldAutoPauseSpend(row.spendUsd, row.monthlySpendLimitUsd) &&
    (!row.generationPaused || row.pauseReason !== 'MANUAL')
  ) {
    // Only the accrual that actually flips generationPaused sends the pause email.
    const paused = await prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "Workspace"
      SET "generationPaused" = true, "pauseReason" = 'SPEND_LIMIT'
      WHERE id = ${workspaceId}
        AND "generationPaused" = false
      RETURNING id
    `;
    if (paused.length === 0) {
      await prisma.$executeRaw`
        UPDATE "Workspace"
        SET "pauseReason" = 'SPEND_LIMIT'
        WHERE id = ${workspaceId}
          AND "generationPaused" = true
          AND ("pauseReason" IS NULL OR "pauseReason" <> 'MANUAL')
      `;
    } else {
      await notifyAdminsSpendLimit({
        workspaceId,
        used: row.spendUsd,
        limit: row.monthlySpendLimitUsd ?? 0,
      });
    }
    return {
      spendUsd: row.spendUsd,
      generationPaused: true,
      pauseReason: 'SPEND_LIMIT' as const,
    };
  }

  return {
    spendUsd: row.spendUsd,
    generationPaused: row.generationPaused,
    pauseReason: row.pauseReason,
  };
}

export async function accrueSandboxSpend(workspaceId: string, minutes: number) {
  return accrueSpend(workspaceId, estimateSandboxCostUsd(minutes));
}
