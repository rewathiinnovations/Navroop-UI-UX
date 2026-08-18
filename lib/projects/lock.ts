import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';

export type LockReason = 'generation' | 'publish' | 'import' | 'audit';

export type LockHolder = { id: string; name: string };

export type AcquireOk = { ok: true };
export type AcquireFail = { ok: false; heldBy: LockHolder; expiresAt: Date };
export type AcquireResult = AcquireOk | AcquireFail;

export type LockOpOk = { ok: true };
export type LockOpFail = { ok: false; error: string };
export type LockOpResult = LockOpOk | LockOpFail;

const DEFAULT_TTL_MINUTES = 15;

type LockRow = {
  lockedById: string | null;
  lockExpiresAt: Date | null;
  holderName: string | null;
};

async function readHolder(projectId: string): Promise<AcquireFail | null> {
  const rows = await prisma.$queryRaw<LockRow[]>`
    SELECT
      p."lockedById",
      p."lockExpiresAt",
      u.name AS "holderName"
    FROM "Project" p
    LEFT JOIN "User" u ON u.id = p."lockedById"
    WHERE p.id = ${projectId}
      AND p."lockedById" IS NOT NULL
      AND p."lockExpiresAt" IS NOT NULL
      AND p."lockExpiresAt" >= NOW()
  `;
  const row = rows[0];
  if (!row?.lockedById || !row.lockExpiresAt) return null;
  return {
    ok: false,
    heldBy: { id: row.lockedById, name: row.holderName || 'Someone' },
    expiresAt: row.lockExpiresAt,
  };
}

export async function acquireLock(
  projectId: string,
  userId: string,
  reason: LockReason,
  ttlMinutes = DEFAULT_TTL_MINUTES,
): Promise<AcquireResult> {
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
  const count = await prisma.$executeRaw`
    UPDATE "Project"
    SET
      "lockedById" = ${userId},
      "lockedAt" = NOW(),
      "lockExpiresAt" = ${expiresAt},
      "lockReason" = ${reason}
    WHERE id = ${projectId}
      AND (
        "lockedById" IS NULL
        OR "lockExpiresAt" IS NULL
        OR "lockExpiresAt" < NOW()
        OR "lockedById" = ${userId}
      )
  `;
  if (count > 0) return { ok: true };
  const held = await readHolder(projectId);
  if (held) return held;
  return {
    ok: false,
    heldBy: { id: '', name: 'Someone' },
    expiresAt,
  };
}

export async function renewLock(projectId: string, userId: string, ttlMinutes = DEFAULT_TTL_MINUTES): Promise<LockOpResult> {
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
  const count = await prisma.$executeRaw`
    UPDATE "Project"
    SET "lockExpiresAt" = ${expiresAt}
    WHERE id = ${projectId}
      AND "lockedById" = ${userId}
      AND "lockExpiresAt" IS NOT NULL
      AND "lockExpiresAt" >= NOW()
  `;
  return count > 0 ? { ok: true } : { ok: false, error: 'Lock is not held' };
}

export async function releaseLock(projectId: string, userId: string): Promise<LockOpResult> {
  const count = await prisma.$executeRaw`
    UPDATE "Project"
    SET
      "lockedById" = NULL,
      "lockedAt" = NULL,
      "lockExpiresAt" = NULL,
      "lockReason" = NULL
    WHERE id = ${projectId}
      AND "lockedById" = ${userId}
  `;
  return count > 0 ? { ok: true } : { ok: false, error: 'Lock is not held' };
}

export async function forceRelease(projectId: string, adminUserId: string): Promise<LockOpResult> {
  const admin = await prisma.user.findUnique({
    where: { id: adminUserId },
    select: { role: true },
  });
  if (admin?.role !== 'ADMIN') {
    return { ok: false, error: 'Forbidden' };
  }
  await prisma.$executeRaw`
    UPDATE "Project"
    SET
      "lockedById" = NULL,
      "lockedAt" = NULL,
      "lockExpiresAt" = NULL,
      "lockReason" = NULL
    WHERE id = ${projectId}
  `;
  return { ok: true };
}

export async function bumpContentVersion(projectId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "Project"
    SET "contentVersion" = "contentVersion" + 1
    WHERE id = ${projectId}
  `;
}

export function beginLockHeartbeat(projectId: string, userId: string, intervalMs = 60_000) {
  const timer = setInterval(() => {
    renewLock(projectId, userId).catch((error) => {
      log.warn('lock.renew_failed', {
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, intervalMs);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

/** Releasing is cleanup: a failure here must not replace the error from the work. */
async function releaseQuietly(projectId: string, userId: string) {
  try {
    await releaseLock(projectId, userId);
  } catch (error) {
    log.warn('lock.release_failed', {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function runWithHeldLock<T>(projectId: string, userId: string, work: () => Promise<T>) {
  const heartbeat = beginLockHeartbeat(projectId, userId);
  return work().finally(async () => {
    heartbeat.stop();
    await releaseQuietly(projectId, userId);
  });
}

export async function withProjectLock<T>(
  projectId: string,
  userId: string,
  reason: LockReason,
  work: () => Promise<T>,
): Promise<{ ok: true; value: T } | AcquireFail> {
  const acquired = await acquireLock(projectId, userId, reason);
  if (!acquired.ok) return acquired;
  const heartbeat = beginLockHeartbeat(projectId, userId);
  try {
    const value = await work();
    return { ok: true, value };
  } finally {
    heartbeat.stop();
    await releaseQuietly(projectId, userId);
  }
}
