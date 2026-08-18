import type { JobStatus } from './types';

const TERMINAL: JobStatus[] = ['SUCCEEDED', 'FAILED', 'ABANDONED', 'CANCELLED'];

export function isJobInFlight(status?: string | null) {
  return status === 'QUEUED' || status === 'RUNNING';
}

export function isChatRecoveryStatus(status?: string | null) {
  return status === 'ABANDONED' || status === 'FAILED' || status === 'CANCELLED';
}

/** Chat recovery is for work the person started from chat — not publish, audit, or crons. */
export function showsChatRecovery(kind?: string | null) {
  return kind === 'PLAN' || kind === 'BUILD' || kind === 'FOLLOWUP' || kind === 'IMPORT';
}

export function isSandboxChatLocked(status?: string | null) {
  return status === 'BOOTING';
}

export function isChatBuilding(input: {
  phase?: string | null;
  jobStatus?: string | null;
  recoveryActive?: boolean;
}) {
  if (input.recoveryActive) return false;
  return isJobInFlight(input.jobStatus);
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
  sandboxLocked?: boolean;
  projectLocked?: boolean;
}) {
  if (input.sandboxLocked || input.projectLocked || input.disabled) return true;
  if (isChatBuilding(input)) return true;
  if (input.recoveryActive) return false;
  if (input.jobStatus && TERMINAL.includes(input.jobStatus as JobStatus)) return false;
  return Boolean(input.sending);
}
