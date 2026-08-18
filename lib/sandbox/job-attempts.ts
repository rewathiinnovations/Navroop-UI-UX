import { prisma } from '@/lib/db';
import type { CreateAttempt } from './failover';

export type StoredSandboxAttempt = {
  configId: string;
  driver: string;
  ok: boolean;
  error?: string;
  at: string;
  selectionReason?: string;
};

export type StoredSandboxSkipped = {
  configId: string;
  name: string;
  reason: string;
};

/**
 * Whitelist only the public Job fields. CreateAttempt may carry leftover
 * candidate properties in tests or future callers — never persist those.
 */
export function toStoredSandboxChoice(attempts: CreateAttempt[]): {
  sandboxAttempts: StoredSandboxAttempt[];
  sandboxSkipped: StoredSandboxSkipped[];
} {
  const sandboxAttempts = attempts.map((attempt) => {
    const row: StoredSandboxAttempt = {
      configId: String(attempt.configId),
      driver: String(attempt.driver),
      ok: Boolean(attempt.ok),
      at: String(attempt.at),
    };
    if (attempt.error) row.error = String(attempt.error);
    if (attempt.selectionReason) row.selectionReason = String(attempt.selectionReason);
    return row;
  });
  const firstSkipped = attempts.find((row) => row.skipped && row.skipped.length > 0)?.skipped ?? [];
  const sandboxSkipped = firstSkipped.map((row) => ({
    configId: String(row.configId),
    name: String(row.name),
    reason: String(row.reason),
  }));
  return { sandboxAttempts, sandboxSkipped };
}

/**
 * `ok` on a stored attempt means the boot finished READY — not that the
 * provider was selected or that `create()` returned a handle. A later
 * ready/install failure must flip the last create-ok row.
 */
export function markSandboxAttemptBootFailed<T extends { ok: boolean; error?: string }>(
  attempts: T[],
  error: string,
): T[] {
  if (attempts.length === 0) return attempts;
  const last = attempts.length - 1;
  return attempts.map((attempt, index) => {
    if (index !== last) return attempt;
    return { ...attempt, ok: false, error };
  });
}

export async function recordSandboxAttempts(
  jobId: string | null | undefined,
  attempts: CreateAttempt[],
  configId?: string | null,
) {
  if (!jobId) return;
  const rows = await prisma.$queryRaw<Array<{ resourceIds: unknown }>>`
    SELECT "resourceIds" FROM "GenerationJob" WHERE id = ${jobId} LIMIT 1
  `;
  if (!rows[0]) return;
  const current =
    rows[0].resourceIds && typeof rows[0].resourceIds === 'object'
      ? (rows[0].resourceIds as Record<string, unknown>)
      : {};
  const choice = toStoredSandboxChoice(attempts);
  const next = {
    ...current,
    sandboxAttempts: choice.sandboxAttempts,
    sandboxSkipped: choice.sandboxSkipped.length > 0 ? choice.sandboxSkipped : (current.sandboxSkipped ?? null),
    sandboxProviderConfigId: configId ?? current.sandboxProviderConfigId ?? null,
  };
  await prisma.$executeRaw`
    UPDATE "GenerationJob"
    SET
      "resourceIds" = ${JSON.stringify(next)}::jsonb,
      "providerConfigId" = ${configId ?? null},
      "updatedAt" = NOW()
    WHERE id = ${jobId}
  `;
}
