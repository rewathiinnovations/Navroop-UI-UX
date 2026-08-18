export const HEARTBEAT_INTERVAL_MS = 10_000;
export const HEARTBEAT_STALE_MS = 60_000;
/**
 * Consecutive failed heartbeat writes after which the job is stale to the reaper even
 * though it is still working. Derived, so it cannot drift from the two values above.
 */
export const HEARTBEAT_FAILURES_BEFORE_STALE = Math.max(
  1,
  Math.floor(HEARTBEAT_STALE_MS / HEARTBEAT_INTERVAL_MS),
);
export const JOB_TIMEOUT_MS = 20 * 60_000;
export const PROGRESS_BATCH_MS = 2_000;
export const CLIENT_STALE_HEARTBEAT_MS = 90_000;
export const CLIENT_POLL_CEILING_MS = 25 * 60_000;
export const POLL_FAST_MS = 2_000;
export const POLL_SLOW_MS = 10_000;
export const POLL_BACKOFF_AFTER_MS = 2 * 60_000;

export type ClientPollStopReason = 'timeout' | 'stale_heartbeat';

export function isHeartbeatStale(
  heartbeatAt: Date | string | null | undefined,
  now = new Date(),
  staleMs = HEARTBEAT_STALE_MS,
) {
  if (!heartbeatAt) return true;
  const at = heartbeatAt instanceof Date ? heartbeatAt : new Date(heartbeatAt);
  return now.getTime() - at.getTime() > staleMs;
}

export function isJobTimedOut(
  startedAt: Date | string | null | undefined,
  now = new Date(),
  timeoutMs = JOB_TIMEOUT_MS,
) {
  if (!startedAt) return false;
  const at = startedAt instanceof Date ? startedAt : new Date(startedAt);
  return now.getTime() - at.getTime() > timeoutMs;
}

export function nextPollIntervalMs(elapsedMs: number) {
  return elapsedMs > POLL_BACKOFF_AFTER_MS ? POLL_SLOW_MS : POLL_FAST_MS;
}

export function shouldStopClientPoll(input: {
  startedAtMs: number;
  heartbeatAt: Date | string | null | undefined;
  now?: Date;
}): ClientPollStopReason | null {
  const now = input.now ?? new Date();
  if (now.getTime() - input.startedAtMs >= CLIENT_POLL_CEILING_MS) return 'timeout';
  if (isHeartbeatStale(input.heartbeatAt, now, CLIENT_STALE_HEARTBEAT_MS)) return 'stale_heartbeat';
  return null;
}
