import { describe, expect, it } from 'vitest';
import { isChatRecoveryStatus, isJobSettled } from '@/lib/jobs/chat-ui';
import { CLIENT_STALE_HEARTBEAT_MS, isHeartbeatStale, shouldStopClientPoll } from '@/lib/jobs/poll';

/**
 * A build that succeeded must never tell the person it failed.
 *
 * The client watches a running job with a stale-heartbeat watchdog. The
 * heartbeat stops when the job ends, so every finished job is "stale" 90
 * seconds later — and a background tab, where browsers throttle timers to a
 * minute or more, is past that on its next tick. The watchdog used to be
 * consulted before the job's own status, so a real generation that had
 * SUCCEEDED showed "The last build did not finish" with Try again / Start
 * over, while its files sat in the database and the preview rendered them.
 */

describe('a settled job outranks the client watchdog', () => {
  const finishedAt = new Date('2026-08-19T08:02:33.000Z');
  // What the person sees when they come back to the tab a few minutes later.
  const backLater = new Date(finishedAt.getTime() + 5 * 60_000);

  it('treats a finished job as settled', () => {
    expect(isJobSettled('SUCCEEDED')).toBe(true);
    expect(isJobSettled('FAILED')).toBe(true);
    expect(isJobSettled('CANCELLED')).toBe(true);
    expect(isJobSettled('RUNNING')).toBe(false);
    expect(isJobSettled('QUEUED')).toBe(false);
    expect(isJobSettled(null)).toBe(false);
  });

  it('still reports the watchdog verdict for a job that is genuinely stalled', () => {
    // The precondition for the bug: a finished job does look stale.
    expect(isHeartbeatStale(finishedAt, backLater, CLIENT_STALE_HEARTBEAT_MS)).toBe(true);
    expect(
      shouldStopClientPoll({
        startedAtMs: backLater.getTime() - 60_000,
        heartbeatAt: finishedAt,
        now: backLater,
      }),
    ).toBe('stale_heartbeat');
  });

  it('does not offer recovery for a succeeded job the watchdog called stale', () => {
    const clientStop = shouldStopClientPoll({
      startedAtMs: backLater.getTime() - 60_000,
      heartbeatAt: finishedAt,
      now: backLater,
    });
    // The expression useGenerationJob derives `recovery` from.
    const recovery = (status: string | null) =>
      isJobSettled(status) ? isChatRecoveryStatus(status) : clientStop !== null;

    expect(recovery('SUCCEEDED')).toBe(false);
    expect(recovery('FAILED')).toBe(true);
    // A job still in flight with a dead heartbeat is a real stall.
    expect(recovery('RUNNING')).toBe(true);
  });
});
