import type { JobStatus } from './types';

const TERMINAL: JobStatus[] = ['SUCCEEDED', 'FAILED', 'ABANDONED', 'CANCELLED'];

export function isJobInFlight(status?: string | null) {
  return status === 'QUEUED' || status === 'RUNNING';
}

export function isChatRecoveryStatus(status?: string | null) {
  return status === 'ABANDONED' || status === 'FAILED' || status === 'CANCELLED';
}

/**
 * The job reached an end state, so nothing more is coming.
 *
 * A settled job cannot be stalled, which is what the client's stale-heartbeat
 * watchdog decides. The heartbeat stops when a job ends, so 90 seconds later
 * every finished job looks stale — and a backgrounded tab (where timers are
 * throttled to a minute or more) is past that on its very next tick. Without
 * this, a build that succeeded reported itself as "The last build did not
 * finish" whenever the person looked away while it ran.
 */
export function isJobSettled(status?: string | null) {
  return status === 'SUCCEEDED' || isChatRecoveryStatus(status);
}

/** Chat recovery is for work the person started from chat — not publish, audit, or crons. */
export function showsChatRecovery(kind?: string | null) {
  return kind === 'PLAN' || kind === 'BUILD' || kind === 'FOLLOWUP' || kind === 'IMPORT';
}

export function isChatBuilding(input: {
  phase?: string | null;
  jobStatus?: string | null;
  recoveryActive?: boolean;
  /** A generation streaming in this tab right now. */
  streaming?: boolean;
}) {
  if (input.recoveryActive) return false;
  if (isJobInFlight(input.jobStatus)) return true;
  // A stream running in this tab is a build before any poll can say so. The
  // polled status still carries the *previous* job's SUCCEEDED for the first
  // seconds, so the chat fell through to a bare "Navroop is working…" — no file
  // name, no elapsed clock — which is what read as nothing happening. Plan
  // refinement is excluded: it streams, but it is not building a site.
  return Boolean(input.streaming) && input.phase !== 'PLANNING';
}

export function chatPlaceholder(input: {
  phase?: string | null;
  jobStatus?: string | null;
  recoveryActive?: boolean;
}) {
  if (isChatBuilding(input)) return 'Building — hang tight…';
  if (input.phase === 'PLANNING') return 'Tell me what to change, or approve above…';
  return 'Ask Navroop…';
}

export function isChatLocked(input: {
  sending?: boolean;
  disabled?: boolean;
  phase?: string | null;
  jobStatus?: string | null;
  recoveryActive?: boolean;
  projectLocked?: boolean;
}) {
  if (input.projectLocked || input.disabled) return true;
  if (isChatBuilding(input)) return true;
  if (input.recoveryActive) return false;
  if (input.jobStatus && TERMINAL.includes(input.jobStatus as JobStatus)) return false;
  return Boolean(input.sending);
}
