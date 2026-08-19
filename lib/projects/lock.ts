import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';

export type LockReason = 'generation' | 'publish' | 'import' | 'audit';

export type LockHolder = { id: string; name: string };

/**
 * `reentered` is true when the caller already held a live lock on this project, so the
 * acquire was a no-op rather than a fresh take. Callers that release on the way out
 * MUST NOT do so in that case — prefer `holdProjectLock`, which decides that for them.
 */
export type AcquireOk = { ok: true; reentered: boolean };
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

/**
 * Re-entrant for the same user on purpose: a request that already holds the lock — its
 * own running generation, say — must not 409 itself.
 *
 * Re-entry is *reported* rather than silently absorbed because the caller has to know
 * whether it owns the hold: the hand-rolled acquire/heartbeat/release triple used to
 * release unconditionally, which unlocked an in-flight generation belonging to the same
 * user, broke its `renewLock`, and left the project acquirable by a concurrent publish
 * writing the same `lastCode` (security review NAV-03). `holdProjectLock` is the wrapper
 * that consumes this flag so no call site has to.
 *
 * The UPDATE deliberately does *not* carry an `OR "lockedById" = ${userId}` arm. A live
 * hold by this same user must fall through to the re-entry check below so the original
 * holder's `lockReason`, `lockedAt` and `lockExpiresAt` all survive untouched — a nested
 * acquire is not allowed to re-stamp the outer hold. Only a dead hold (no holder, or an
 * expiry that is NULL or already past) is overwritten, and that counts as a fresh take
 * even when the dead lock was ours, because there is nothing left to preserve.
 */
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
      )
  `;
  if (count > 0) return { ok: true, reentered: false };
  const held = await readHolder(projectId);
  if (held?.heldBy.id === userId) return { ok: true, reentered: true };
  if (held) return held;
  return {
    ok: false,
    heldBy: { id: '', name: 'Someone' },
    expiresAt,
  };
}

export async function renewLock(
  projectId: string,
  userId: string,
  ttlMinutes = DEFAULT_TTL_MINUTES,
): Promise<LockOpResult> {
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

/** Nothing to hand back: we re-entered a hold someone else's scope still owns. */
const releaseNothing = async () => undefined;

/**
 * A lock this scope is responsible for. `release()` stops the heartbeat and gives the
 * lock back — and does nothing at all when we merely re-entered a hold we did not take.
 *
 * This object exists so that re-entry cannot be forgotten. The `acquireLock` +
 * `beginLockHeartbeat` + `releaseLock` triple was hand-rolled at six call sites — both
 * publish entry points, import, generation, code audit, SEO audit — and every one of them
 * released unconditionally, because `acquireLock` is re-entrant for the same user: an
 * audit or a publish started by the owner of a running generation took `ok: true`, started
 * a second timer renewing a hold it did not own, and then freed the generation's lock in
 * its own cleanup — after which the generation's `renewLock` answered "Lock is not held"
 * and a concurrent run could take the lock and write the same `Project.lastCode`
 * (security review NAV-03). Handing back a `release` that already knows the answer
 * removes the per-call-site rule all six sites missed.
 */
export type LockHold = {
  /** True when a live hold of ours was already in place, so this scope owns nothing. */
  reentered: boolean;
  /** Idempotent, so it is safe from both a `finally` and an error path. */
  release: () => Promise<void>;
};

export async function holdProjectLock(
  projectId: string,
  userId: string,
  reason: LockReason,
): Promise<({ ok: true } & LockHold) | AcquireFail> {
  const acquired = await acquireLock(projectId, userId, reason);
  if (!acquired.ok) return acquired;
  // Re-entry owns nothing: no heartbeat of our own — the original holder is already
  // renewing, and a second timer would push out an expiry we have no claim on — and no
  // release, so the outer hold's reason, `lockedAt` and expiry come out as they went in.
  if (acquired.reentered) return { ok: true, reentered: true, release: releaseNothing };
  const heartbeat = beginLockHeartbeat(projectId, userId);
  let released = false;
  return {
    ok: true,
    reentered: false,
    release: async () => {
      if (released) return;
      released = true;
      heartbeat.stop();
      await releaseQuietly(projectId, userId);
    },
  };
}

/**
 * Runs `work` while holding the project lock, then gives the lock back — unless the lock
 * was already ours on the way in, in which case the release is a no-op and the original
 * holder keeps it untouched. See `LockHold` for why that exception is load-bearing.
 */
export async function withProjectLock<T>(
  projectId: string,
  userId: string,
  reason: LockReason,
  work: () => Promise<T>,
): Promise<{ ok: true; value: T } | AcquireFail> {
  const hold = await holdProjectLock(projectId, userId, reason);
  if (!hold.ok) return hold;
  try {
    return { ok: true, value: await work() };
  } finally {
    await hold.release();
  }
}
