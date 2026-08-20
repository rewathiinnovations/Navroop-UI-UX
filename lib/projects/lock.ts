import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';
import { LOCK_LOST_MESSAGE } from './lock-messages';

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

/**
 * A hold that ended before its work did: the renewal that keeps `lockExpiresAt` in the
 * future proved the project is no longer ours, so anything this scope still had in flight
 * must not be written. Distinct from `AcquireFail`, which is a refusal *before* any work.
 */
export type LockLost = { ok: false; lockLost: true; error: string };

/** Re-exported so `lock.ts` consumers do not need a second import for the sentence. */
export { LOCK_LOST_MESSAGE };

/** The reason an aborted `LockHold.lost` signal carries. */
export class ProjectLockLostError extends Error {
  readonly projectId: string;
  constructor(projectId: string) {
    super(LOCK_LOST_MESSAGE);
    this.name = 'ProjectLockLostError';
    this.projectId = projectId;
  }
}

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

export type LockLostDetail = {
  projectId: string;
  /** `not_held` — the renew UPDATE matched no row. `renew_unavailable` — see below. */
  reason: 'not_held' | 'renew_unavailable';
};

export type LockHeartbeatOptions = {
  intervalMs?: number;
  /**
   * Called once, just before the heartbeat stops itself, when the lock is provably no
   * longer ours. Same shape as `JobHeartbeatOptions.onInactive`, for the same reason: the
   * renewal write is the one place that already observes the row every tick, so it is the
   * cheapest honest place to notice.
   */
  onLost?: (detail: LockLostDetail) => void;
};

export function beginLockHeartbeat(
  projectId: string,
  userId: string,
  options: number | LockHeartbeatOptions = {},
) {
  const { intervalMs = 60_000, onLost } =
    typeof options === 'number' ? { intervalMs: options, onLost: undefined } : options;
  // A thrown renew is a database blip and must not abort a running generation — but once
  // every attempt for a whole TTL has failed, `lockExpiresAt` is in the past, another
  // writer is entitled to take the project, and "keep going quietly" is the F-730 bug
  // rather than tolerance. At the defaults that is the finding's own trigger: 15 ticks.
  const failuresBeforeLost = Math.max(1, Math.ceil((DEFAULT_TTL_MINUTES * 60_000) / intervalMs));
  let consecutiveFailures = 0;
  let stopped = false;

  const declareLost = (reason: LockLostDetail['reason']) => {
    if (stopped) return;
    // Error, not warn: the lock exists to stop two writers producing one `Project.lastCode`
    // (the NAV-03 note below), so losing it while work is in flight is an invariant breach.
    log.error('lock.lost', { projectId, reason });
    // Stopped before the callback so a throwing consumer cannot leave the interval renewing
    // a lock we do not hold.
    stop();
    onLost?.({ projectId, reason });
  };

  const timer = setInterval(() => {
    renewLock(projectId, userId)
      .then((result) => {
        if (result.ok) {
          consecutiveFailures = 0;
          return;
        }
        // The UPDATE matched no row: the hold expired, or someone else took it. Either way
        // this process no longer owns the project. Discarding this result is what made a
        // lost lock silent — the interval kept firing and the run kept writing (F-730).
        declareLost('not_held');
      })
      .catch((error) => {
        consecutiveFailures += 1;
        if (consecutiveFailures >= failuresBeforeLost) {
          declareLost('renew_unavailable');
          return;
        }
        log.warn('lock.renew_failed', {
          projectId,
          consecutiveFailures,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, intervalMs);
  timer.unref?.();

  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  }

  return { stop };
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
  /**
   * Aborted, with a `ProjectLockLostError`, the moment a renewal proves this hold is gone.
   * Long work — a generation streams for minutes and writes `Project.lastCode` at the end —
   * must pass this into whatever it can cancel and check it before its final write, because
   * from that moment on a second run is entitled to write the same row (F-730).
   *
   * Never aborted on re-entry: that scope owns no heartbeat, so it has nothing to observe.
   * The outer hold is the one renewing and the one whose signal fires, and its work
   * encloses this one.
   */
  lost: AbortSignal;
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
  if (acquired.reentered) {
    return {
      ok: true,
      reentered: true,
      lost: new AbortController().signal,
      release: releaseNothing,
    };
  }
  const lostLock = new AbortController();
  const heartbeat = beginLockHeartbeat(projectId, userId, {
    onLost: () => lostLock.abort(new ProjectLockLostError(projectId)),
  });
  let released = false;
  return {
    ok: true,
    reentered: false,
    lost: lostLock.signal,
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
 *
 * `work` is handed the hold's `lost` signal so it can stop early, and a run that finished
 * under a lock it no longer held is reported as `LockLost` rather than as a success: its
 * writes were not protected, so the caller must not tell the user they landed (F-730).
 */
export async function withProjectLock<T>(
  projectId: string,
  userId: string,
  reason: LockReason,
  work: (lost: AbortSignal) => Promise<T>,
): Promise<{ ok: true; value: T } | AcquireFail | LockLost> {
  const hold = await holdProjectLock(projectId, userId, reason);
  if (!hold.ok) return hold;
  try {
    const value = await work(hold.lost);
    if (hold.lost.aborted) return { ok: false, lockLost: true, error: LOCK_LOST_MESSAGE };
    return { ok: true, value };
  } finally {
    await hold.release();
  }
}
