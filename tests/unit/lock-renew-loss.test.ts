import { afterEach, describe, expect, it, vi } from 'vitest';

// `lib/projects/lock.ts` only needs `prisma.$executeRaw` (acquire/renew/release) and
// `prisma.$queryRaw` (the holder read). Both are stubbed so the heartbeat can be driven
// with fake timers instead of a database. Hoisted because `vi.mock`'s factory runs before
// the module body.
const db = vi.hoisted(() => ({ executeRaw: vi.fn(), queryRaw: vi.fn() }));
const { executeRaw, queryRaw } = db;
vi.mock('@/lib/db', () => ({ prisma: { $executeRaw: db.executeRaw, $queryRaw: db.queryRaw } }));
vi.mock('@/lib/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logError: vi.fn(),
}));

import { log } from '@/lib/logger';
import {
  beginLockHeartbeat,
  holdProjectLock,
  LOCK_LOST_MESSAGE,
  withProjectLock,
} from '@/lib/projects/lock';

const PROJECT = 'proj_lock_loss';
const OWNER = 'user_owner';

/** The message an aborted `lost` signal carries, without asserting a shape on the reason. */
function lostReasonMessage(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason.message : String(reason);
}

afterEach(() => {
  vi.useRealTimers();
  executeRaw.mockReset();
  queryRaw.mockReset();
  vi.mocked(log.warn).mockReset();
  vi.mocked(log.error).mockReset();
});

/**
 * F-730: `renewLock` answers `{ ok: false, error: 'Lock is not held' }` when its UPDATE
 * matches no row — the hold expired, or another writer took it. `beginLockHeartbeat` only
 * caught *thrown* errors, so that result was discarded: the interval kept firing against a
 * lock the process no longer held, nothing logged it, and the run kept writing
 * `Project.lastCode` while a second run was entitled to write the same column — precisely
 * the corruption the module's own NAV-03 note says the lock exists to prevent.
 */
describe('beginLockHeartbeat renewal loss (F-730)', () => {
  it('reports and stops when a renewal proves the lock is no longer held', async () => {
    vi.useFakeTimers();
    // The renew UPDATE matched no row.
    executeRaw.mockResolvedValue(0);
    const onLost = vi.fn();
    const heartbeat = beginLockHeartbeat(PROJECT, OWNER, { intervalMs: 10, onLost });
    try {
      await vi.advanceTimersByTimeAsync(10);
      expect(executeRaw).toHaveBeenCalledTimes(1);
      expect(onLost).toHaveBeenCalledTimes(1);
      expect(onLost.mock.calls[0][0]).toMatchObject({ projectId: PROJECT, reason: 'not_held' });
      // Loss is an invariant breach, not a blip: it goes out at error level, once.
      expect(vi.mocked(log.error).mock.calls.map((call) => call[0])).toEqual(['lock.lost']);
      // The interval cleared itself: no further renew attempts against a lock we lost.
      await vi.advanceTimersByTimeAsync(100);
      expect(executeRaw).toHaveBeenCalledTimes(1);
      expect(onLost).toHaveBeenCalledTimes(1);
    } finally {
      heartbeat.stop();
    }
  });

  it('keeps renewing, and stays quiet about loss, while the lock is still ours', async () => {
    vi.useFakeTimers();
    executeRaw.mockResolvedValue(1);
    const onLost = vi.fn();
    const heartbeat = beginLockHeartbeat(PROJECT, OWNER, { intervalMs: 10, onLost });
    try {
      await vi.advanceTimersByTimeAsync(35);
      expect(executeRaw.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(onLost).not.toHaveBeenCalled();
      expect(log.error).not.toHaveBeenCalled();
    } finally {
      heartbeat.stop();
    }
  });

  it('tolerates a transient renew failure but declares loss once a whole TTL of them has failed', async () => {
    vi.useFakeTimers();
    executeRaw.mockRejectedValue(new Error('connection reset'));
    const onLost = vi.fn();
    // The finding's own trigger: 15 consecutive failures at the default 60s tick, which is
    // exactly the 15-minute TTL.
    const heartbeat = beginLockHeartbeat(PROJECT, OWNER, { intervalMs: 60_000, onLost });
    try {
      // A database blip must not abort a running generation.
      await vi.advanceTimersByTimeAsync(60_000 * 3);
      expect(onLost).not.toHaveBeenCalled();
      expect(vi.mocked(log.warn).mock.calls.map((call) => call[0])).toEqual([
        'lock.renew_failed',
        'lock.renew_failed',
        'lock.renew_failed',
      ]);
      // By the fifteenth consecutive failure `lockExpiresAt` has passed, so the lock is
      // provably gone and another writer can take the project.
      await vi.advanceTimersByTimeAsync(60_000 * 12);
      expect(onLost).toHaveBeenCalledTimes(1);
      expect(onLost.mock.calls[0][0]).toMatchObject({ reason: 'renew_unavailable' });
    } finally {
      heartbeat.stop();
    }
  });
});

describe('holdProjectLock surfaces the loss to the work it wraps (F-730)', () => {
  it('aborts the hold’s `lost` signal when the renewal proves the lock is gone', async () => {
    vi.useFakeTimers();
    // acquireLock's UPDATE takes the lock, then every renew matches no row.
    executeRaw.mockResolvedValueOnce(1).mockResolvedValue(0);
    const hold = await holdProjectLock(PROJECT, OWNER, 'generation');
    expect(hold.ok).toBe(true);
    if (!hold.ok) return;
    expect(hold.lost.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hold.lost.aborted).toBe(true);
    expect(lostReasonMessage(hold.lost)).toBe(LOCK_LOST_MESSAGE);
    await hold.release();
  });

  it('re-entry owns no heartbeat, so its `lost` signal never fires', async () => {
    vi.useFakeTimers();
    // The acquire UPDATE matches nothing (a live hold is in place) and `readHolder`
    // reports this same user, so this is a re-entry.
    executeRaw.mockResolvedValue(0);
    queryRaw.mockResolvedValue([
      { lockedById: OWNER, lockExpiresAt: new Date(Date.now() + 600_000), holderName: 'Owner' },
    ]);
    const hold = await holdProjectLock(PROJECT, OWNER, 'audit');
    expect(hold.ok).toBe(true);
    if (!hold.ok) return;
    expect(hold.reentered).toBe(true);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(hold.lost.aborted).toBe(false);
  });
});

describe('withProjectLock refuses to report success under a lost lock (F-730)', () => {
  it('reports the loss instead of the work’s value', async () => {
    vi.useFakeTimers();
    executeRaw.mockResolvedValueOnce(1).mockResolvedValue(0);
    const result = await withProjectLock(PROJECT, OWNER, 'generation', async (lost) => {
      // The renewal fails while the work is in flight.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(lost.aborted).toBe(true);
      return 'written';
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ lockLost: true, error: LOCK_LOST_MESSAGE });
  });

  it('returns the value when the lock was held for the whole run', async () => {
    executeRaw.mockResolvedValue(1);
    const result = await withProjectLock(PROJECT, OWNER, 'generation', async () => 'written');
    expect(result).toMatchObject({ ok: true, value: 'written' });
  });
});
