import type { Checkpoint } from '@/components/workspace/types';
import { emitLockConflict, parseLockConflict } from '@/lib/projects/lock-client';

type CheckpointPayload = {
  id: string;
  label: string;
  thumbnailUrl: string | null;
  createdAt: string;
  isBookmarked?: boolean;
  snapshotPruned?: boolean;
};

function toCheckpoint(row: CheckpointPayload): Checkpoint {
  return {
    id: row.id,
    label: row.label,
    thumbnailUrl: row.thumbnailUrl,
    createdAt: row.createdAt,
    isBookmarked: Boolean(row.isBookmarked),
    snapshotPruned: Boolean(row.snapshotPruned),
  };
}

async function readJson(response: Response) {
  return (await response.json().catch(() => null)) as {
    checkpoints?: CheckpointPayload[];
    checkpoint?: CheckpointPayload;
    previewingCheckpointId?: string | null;
    error?: string;
    code?: string;
    heldBy?: { name?: string };
    expiresAt?: string;
    details?: { code?: string; heldBy?: { name?: string }; expiresAt?: string };
  } | null;
}

/**
 * The history *and* which version the project is currently previewing.
 *
 * The previewing flag comes from the server because it is a column now (F-102): the old
 * client-only `useState` was lost on reload, so a project that had been rolled back by
 * "Preview this version" looked like its own current version.
 */
export async function fetchCheckpoints(
  projectId: string,
): Promise<{ checkpoints: Checkpoint[]; previewingCheckpointId: string | null }> {
  const response = await fetch(`/api/projects/${projectId}/checkpoints`);
  const data = await readJson(response);
  if (!response.ok) {
    throw new Error(data?.error || 'Could not load version history');
  }
  return {
    checkpoints: (data?.checkpoints ?? []).map(toCheckpoint),
    previewingCheckpointId: data?.previewingCheckpointId ?? null,
  };
}

/**
 * Carries the lock verdict alongside the message so callers do not have to sniff
 * the sentence to recognise a conflict. `restoreCheckpoint` was the only call that
 * handled a 409, and the workspace read `'is working on this project'` out of its
 * message to keep the LockBar up; preview and exit now take the same server lock as
 * restore, so the verdict is produced once, here.
 *
 * `toggleCheckpointBookmark` is the asymmetric one: owner-gated, but deliberately
 * unlocked. It flips `Checkpoint.isBookmarked` and touches neither `Project.lastCode`
 * nor `contentVersion`, so there is no content write to serialise against a running
 * generation — it can never return a lock 409, and `locked` stays false for it.
 */
export class CheckpointRequestError extends Error {
  readonly status: number;
  readonly locked: boolean;

  constructor(message: string, status: number, locked: boolean) {
    super(message);
    this.name = 'CheckpointRequestError';
    this.status = status;
    this.locked = locked;
  }
}

/** True only for a 409 that named a real lock holder — the case the LockBar shows. */
export function isLockConflictError(error: unknown): boolean {
  return error instanceof CheckpointRequestError && error.locked;
}

/**
 * The single request path for every checkpoint write. A 409 raises the LockBar via
 * `emitLockConflict` before throwing, so the next checkpoint call added here cannot
 * forget it — four copies of that branch is how three of them came to be missing.
 *
 * `data.error` is thrown verbatim: the server owns the user-facing sentence (see
 * `forbidden()` in ./actions.ts for the 403 wording). `fallback` covers only a body
 * that carried no message at all, so no status word can reach the chat thread.
 */
async function checkpointRequest(url: string, fallback: string) {
  const response = await fetch(url, { method: 'POST' });
  const data = await readJson(response);
  if (response.ok) return data;

  let locked = false;
  if (response.status === 409) {
    // A pruned snapshot is also a 409 but names no holder, so it stays a chat line.
    const conflict = parseLockConflict(409, data);
    if (conflict) {
      emitLockConflict(conflict);
      locked = true;
    }
  }
  throw new CheckpointRequestError(data?.error || fallback, response.status, locked);
}

export async function previewCheckpoint(projectId: string, checkpointId: string) {
  const data = await checkpointRequest(
    `/api/projects/${projectId}/checkpoints/${checkpointId}/preview`,
    'Could not preview this version',
  );
  return data?.checkpoint ? toCheckpoint(data.checkpoint) : null;
}

export async function exitCheckpointPreview(projectId: string) {
  const data = await checkpointRequest(
    `/api/projects/${projectId}/checkpoints/exit`,
    'Could not return to the current version',
  );
  return data?.checkpoint ? toCheckpoint(data.checkpoint) : null;
}

export async function toggleCheckpointBookmark(projectId: string, checkpointId: string) {
  const data = await checkpointRequest(
    `/api/projects/${projectId}/checkpoints/${checkpointId}/bookmark`,
    'Could not bookmark this version',
  );
  return data?.checkpoint ? toCheckpoint(data.checkpoint) : null;
}

export async function restoreCheckpoint(projectId: string, checkpointId: string) {
  const data = await checkpointRequest(
    `/api/projects/${projectId}/checkpoints/${checkpointId}/restore`,
    'Could not restore this version',
  );
  return data?.checkpoint ? toCheckpoint(data.checkpoint) : null;
}
