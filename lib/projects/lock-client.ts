export const PROJECT_LOCK_EVENT = 'navroop:project-lock';

export type LockConflictDetail = {
  name: string;
  expiresAt: string;
};

export function emitLockConflict(detail: LockConflictDetail) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(PROJECT_LOCK_EVENT, { detail }));
}

export function parseLockConflict(status: number, body: unknown): LockConflictDetail | null {
  if (status !== 409 || !body || typeof body !== 'object') return null;
  const row = body as {
    code?: string;
    details?: { code?: string; heldBy?: { name?: string }; expiresAt?: string };
    heldBy?: { name?: string };
    expiresAt?: string;
  };
  const locked = row.code === 'PROJECT_LOCKED' || row.details?.code === 'PROJECT_LOCKED' || Boolean(row.heldBy || row.details?.heldBy);
  if (!locked) return null;
  const name = row.heldBy?.name || row.details?.heldBy?.name;
  const expiresAt = row.expiresAt || row.details?.expiresAt;
  if (!name || !expiresAt) return null;
  return { name, expiresAt };
}

export function formatLockRemaining(expiresAt: Date | string) {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'a moment left';
  const minutes = Math.ceil(ms / 60_000);
  if (minutes >= 2) return `${minutes} min left`;
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  return `${seconds} sec left`;
}

export function lockWorkingMessage(name: string) {
  return `${name} is working on this project`;
}
