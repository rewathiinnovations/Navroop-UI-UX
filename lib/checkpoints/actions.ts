import { prisma } from '@/lib/db';
import { getSessionUser, type SessionUser } from '@/lib/auth';
import { peekActor } from '@/lib/projects/plan';
import { peekConversationState } from '@/lib/generation/conversation-state';
import { Prisma } from '@/generated/prisma';
import {
  captureFileSnapshot,
  readSnapshot,
  snapshotsEqual,
  SnapshotReadError,
  writeSnapshot,
  type FileSnapshotEntry,
  type SnapshotRecord,
} from './snapshot';
import { captureThumbnail } from './thumbnail';
import { recordRevertRate } from '@/lib/signals/collect';
import { adjustStorageBytes, WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { checkLimit } from '@/lib/plans/limits';
import { gzipSync } from 'node:zlib';
import { toLastCode } from '@/lib/projects/last-code';
import { bumpContentVersion, withProjectLock } from '@/lib/projects/lock';
import { lockConflictAction } from '@/lib/projects/lock-http';

export type CheckpointTrigger = 'initial' | 'followup' | 'restore';

export type PublicCheckpoint = {
  id: string;
  label: string;
  thumbnailUrl: string | null;
  createdAt: string;
  trigger: CheckpointTrigger;
  sourceMessage: string | null;
  isBookmarked: boolean;
  snapshotPruned: boolean;
};

type ActionErr = { ok: false; error: string; status: number; details?: unknown };
type ActionOk<T> = { ok: true; data: T };

function unauthorized(): ActionErr {
  return { ok: false, error: 'Sign in required', status: 401 };
}

function notFound(): ActionErr {
  return { ok: false, error: 'Project not found', status: 404 };
}

/**
 * A sentence rather than the bare "Forbidden" the HTTP layer would use: every caller of
 * these four actions goes through lib/checkpoints/client.ts, which throws `data.error`
 * verbatim, and the workspace posts that string straight into the user's chat thread.
 * The rest of this file's errors read the same way for the same reason.
 */
function forbidden(): ActionErr {
  return { ok: false, error: 'This project belongs to someone else', status: 403 };
}

function canRestore(user: SessionUser, ownerId: string) {
  return user.id === ownerId || user.role === 'ADMIN';
}

async function requireActor() {
  const stored = peekActor();
  if (stored) return { user: stored, err: null };
  const user = await getSessionUser();
  if (!user) return { user: null, err: unauthorized() as ActionErr };
  return { user, err: null };
}

function labelFromSource(source?: string | null) {
  const cleaned = (source ?? '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'Latest generation';
  return cleaned.length > 40 ? cleaned.slice(0, 40) : cleaned;
}

function restoreLabel(originalCreatedAt?: Date | null) {
  const when = originalCreatedAt
    ? originalCreatedAt.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
    : 'previous version';
  return `Restored to version from ${when}`;
}

function lastConversationUserMessage(projectId: string) {
  // The project's own keyed conversation, never the old process-global — that slot held
  // whichever project generated last, so a follow-up checkpoint here could be named
  // after another user's prompt and display it verbatim in version history. No entry
  // for this project means no label source; `labelFromSource` then falls back to
  // 'Latest generation'.
  const messages = peekConversationState(projectId)?.context.messages;
  if (!messages?.length) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const entry = messages[i];
    if (entry.role === 'user' && typeof entry.content === 'string' && entry.content.trim()) {
      return entry.content.trim();
    }
  }
  return null;
}

function toPublic(row: {
  id: string;
  label: string;
  thumbnailUrl: string | null;
  createdAt: Date;
  trigger: string;
  sourceMessage: string | null;
  isBookmarked?: boolean;
  snapshotPruned?: boolean;
}): PublicCheckpoint {
  return {
    id: row.id,
    label: row.label,
    thumbnailUrl: row.thumbnailUrl,
    createdAt: row.createdAt.toISOString(),
    trigger:
      row.trigger === 'restore' ? 'restore' : row.trigger === 'followup' ? 'followup' : 'initial',
    sourceMessage: row.sourceMessage,
    isBookmarked: Boolean(row.isBookmarked),
    snapshotPruned: Boolean(row.snapshotPruned),
  };
}

/** Internal. No extra auth — callers are already inside a trusted persist/restore path. */
export async function createCheckpoint(
  projectId: string,
  input: {
    trigger: CheckpointTrigger;
    sourceMessage?: string | null;
    previewUrl?: string | null;
    restoredFromAt?: Date | null;
  },
) {
  const fileSnapshot = await captureFileSnapshot(projectId);
  if (fileSnapshot.length === 0) {
    throw new Error('Cannot create checkpoint: file snapshot is empty');
  }

  const label =
    input.trigger === 'restore'
      ? restoreLabel(input.restoredFromAt)
      : labelFromSource(input.sourceMessage);

  let thumbnailUrl: string | null = null;
  try {
    thumbnailUrl = await captureThumbnail(input.previewUrl, projectId);
  } catch (error) {
    console.warn('[checkpoints] thumbnail failed', error);
  }

  const created = await prisma.checkpoint.create({
    data: {
      projectId,
      label,
      sourceMessage: input.sourceMessage ?? null,
      trigger: input.trigger,
      fileSnapshot: Prisma.DbNull,
      thumbnailUrl,
    },
  });

  try {
    const upcoming = gzipSync(Buffer.from(JSON.stringify(fileSnapshot), 'utf8')).length;
    const storage = await checkLimit(WORKSPACE_ROW_ID, 'storage', upcoming);
    if (!storage.ok) {
      await prisma.checkpoint.delete({ where: { id: created.id } }).catch((error) => {
        console.warn('[checkpoints] rollback delete failed, row has no snapshot', error);
      });
      throw new Error(storage.message || 'Workspace storage limit is used up');
    }
    const written = await writeSnapshot(projectId, created.id, fileSnapshot);
    await prisma.checkpoint.update({
      where: { id: created.id },
      data: {
        snapshotKey: written.snapshotKey,
        snapshotBytes: written.snapshotBytes,
        snapshotFileCount: written.snapshotFileCount,
      },
    });
    await adjustStorageBytes(written.snapshotBytes);
  } catch (error) {
    await prisma.checkpoint.delete({ where: { id: created.id } }).catch((deleteError) => {
      console.warn('[checkpoints] rollback delete failed, row has no snapshot', deleteError);
    });
    throw error;
  }

  if (thumbnailUrl) {
    await prisma.project.update({
      where: { id: projectId },
      data: { thumbnailUrl },
    });
  }

  return prisma.checkpoint.findUniqueOrThrow({ where: { id: created.id } });
}

export async function createCheckpointAfterGeneration(
  projectId: string,
  input: {
    previousPhase: 'PLANNING' | 'BUILDING' | 'COMPLETE';
    previewUrl?: string | null;
    sourceMessage?: string | null;
  },
) {
  let trigger: CheckpointTrigger = 'followup';
  let sourceMessage = input.sourceMessage ?? lastConversationUserMessage(projectId);

  if (input.previousPhase === 'BUILDING') {
    const plan = await prisma.projectPlan.findFirst({
      where: { projectId, status: 'APPROVED' },
      orderBy: { version: 'desc' },
      select: { trigger: true, sourceMessage: true },
    });
    const project = await prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { initialPrompt: true },
    });
    trigger = plan?.trigger === 'followup' ? 'followup' : 'initial';
    sourceMessage = plan?.sourceMessage ?? project?.initialPrompt ?? sourceMessage;
  }

  const snapshot = await captureFileSnapshot(projectId);
  // Nothing to snapshot is a legitimate outcome, not a fault. A zero-file reply
  // is now an answer turn ("hello" on a project with no site yet), and it ends
  // with the same terminal ready PATCH as a build — which threw here, was caught
  // and logged by the caller, and put an error line in the log for an entirely
  // normal chat message. Callers already handle `null` (dedupe returns it too).
  if (snapshot.length === 0) {
    return null;
  }

  const latest = await prisma.checkpoint.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    select: { snapshotKey: true, fileSnapshot: true },
  });
  // Deliberately not caught: `snapshotsEqual([], snapshot)` is never true, so a failed
  // read would defeat dedupe and write a duplicate checkpoint on every generation,
  // inflating Workspace.storageBytes. Creating one is impossible anyway while storage is
  // down — writeSnapshot would fail and roll the row back — so this throws instead, and
  // the caller in lib/projects/actions.ts logs it.
  if (latest && snapshotsEqual(await readSnapshot(latest), snapshot)) {
    return null;
  }

  return createCheckpoint(projectId, {
    trigger,
    sourceMessage,
    previewUrl: input.previewUrl,
  });
}

export async function getCheckpoints(projectId: string) {
  const { user, err } = await requireActor();
  if (!user) return err;

  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true },
  });
  if (!project) return notFound();

  const rows = await prisma.checkpoint.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      label: true,
      thumbnailUrl: true,
      createdAt: true,
      trigger: true,
      sourceMessage: true,
      isBookmarked: true,
      snapshotPruned: true,
    },
  });

  return { ok: true as const, data: rows.map(toPublic) };
}

async function loadProjectForWrite(projectId: string) {
  return prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, ownerId: true, previewUrl: true },
  });
}

/**
 * Restoring writes the snapshot back to `Project.lastCode`, which is the
 * source of truth the in-browser preview renders from. This used to push the
 * files into a sandbox VM; there is no VM now, and a restore that only touched
 * a VM would be lost on the next reload.
 */
async function writeCheckpointFiles(projectId: string, files: FileSnapshotEntry[]) {
  if (files.length === 0) {
    throw new Error('Checkpoint has no files to write');
  }
  const lastCode = toLastCode(Object.fromEntries(files.map((file) => [file.path, file.content])));
  await prisma.project.update({
    where: { id: projectId },
    data: { lastCode },
  });
  await bumpContentVersion(projectId);
}

function prunedError() {
  return { ok: false as const, error: 'Old checkpoint — cannot restore', status: 409 };
}

function storageUnavailableError(): ActionErr {
  return {
    ok: false,
    error: 'Could not read this version from storage. Nothing was changed — try again in a moment.',
    status: 503,
  };
}

/**
 * A failed read must not share an answer with an empty snapshot. `files.length === 0`
 * routes to `prunedError()`, so treating a storage blip as zero files tells the user
 * their version is permanently gone — the one message that stops them retrying.
 */
async function loadSnapshotFiles(
  record: SnapshotRecord,
): Promise<{ ok: true; files: FileSnapshotEntry[] } | { ok: false; err: ActionErr }> {
  try {
    return { ok: true, files: await readSnapshot(record) };
  } catch (error) {
    if (error instanceof SnapshotReadError) {
      console.error('[checkpoints] snapshot read failed, not reporting it as pruned', error);
      return { ok: false, err: storageUnavailableError() };
    }
    throw error;
  }
}

/**
 * Despite the name this is a *write*: it replaces `Project.lastCode`, so it needs the
 * same two guards as `restoreCheckpoint` below. Both were missing. Without the owner
 * check any signed-in member could roll another member's project back to an arbitrary
 * checkpoint; without the lock the write raced a running generation and bumped
 * `contentVersion` underneath the generating client.
 */
export async function previewCheckpoint(projectId: string, checkpointId: string) {
  const { user, err } = await requireActor();
  if (!user) return err;

  const project = await loadProjectForWrite(projectId);
  if (!project) return notFound();
  if (!canRestore(user, project.ownerId)) return forbidden();

  const checkpoint = await prisma.checkpoint.findFirst({
    where: { id: checkpointId, projectId },
  });
  if (!checkpoint) return { ok: false as const, error: 'Checkpoint not found', status: 404 };
  if (checkpoint.snapshotPruned) return prunedError();

  const loaded = await loadSnapshotFiles(checkpoint);
  if (!loaded.ok) return loaded.err;
  const files = loaded.files;
  if (files.length === 0) return prunedError();

  const locked = await withProjectLock(projectId, user.id, 'generation', () =>
    writeCheckpointFiles(projectId, files),
  );
  if (!locked.ok) return lockConflictAction(locked);

  return { ok: true as const, data: toPublic(checkpoint) };
}

export async function exitCheckpointPreview(projectId: string) {
  const { user, err } = await requireActor();
  if (!user) return err;

  const project = await loadProjectForWrite(projectId);
  if (!project) return notFound();
  if (!canRestore(user, project.ownerId)) return forbidden();

  const latest = await prisma.checkpoint.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
  });
  if (!latest) {
    return { ok: false as const, error: 'No current checkpoint to restore', status: 409 };
  }

  const loaded = await loadSnapshotFiles(latest);
  if (!loaded.ok) return loaded.err;
  const files = loaded.files;
  if (latest.snapshotPruned || files.length === 0) return prunedError();

  const locked = await withProjectLock(projectId, user.id, 'generation', () =>
    writeCheckpointFiles(projectId, files),
  );
  if (!locked.ok) return lockConflictAction(locked);

  return { ok: true as const, data: toPublic(latest) };
}

export async function restoreCheckpoint(projectId: string, checkpointId: string) {
  const { user, err } = await requireActor();
  if (!user) return err;

  const project = await loadProjectForWrite(projectId);
  if (!project) return notFound();
  if (!canRestore(user, project.ownerId)) return forbidden();

  const checkpoint = await prisma.checkpoint.findFirst({
    where: { id: checkpointId, projectId },
  });
  if (!checkpoint) return { ok: false as const, error: 'Checkpoint not found', status: 404 };
  if (checkpoint.snapshotPruned) return prunedError();

  const loaded = await loadSnapshotFiles(checkpoint);
  if (!loaded.ok) return loaded.err;
  const files = loaded.files;
  if (files.length === 0) return prunedError();

  const locked = await withProjectLock(projectId, user.id, 'generation', async () => {
    await writeCheckpointFiles(projectId, files);
    const created = await createCheckpoint(projectId, {
      trigger: 'restore',
      sourceMessage: null,
      previewUrl: project.previewUrl,
      restoredFromAt: checkpoint.createdAt,
    });
    await bumpContentVersion(projectId);
    void recordRevertRate(projectId);
    try {
      const { buildPreviewForProject } = await import('@/lib/preview/production');
      await buildPreviewForProject(projectId, created.id);
    } catch (error) {
      console.warn('[preview] build after restore failed', error);
    }
    return created;
  });
  if (!locked.ok) return lockConflictAction(locked);

  return { ok: true as const, data: toPublic(locked.value) };
}

export async function toggleCheckpointBookmark(projectId: string, checkpointId: string) {
  const { user, err } = await requireActor();
  if (!user) return err;

  // Bookmarks live on the owner's checkpoint history, so the same gate applies here as
  // on the content writes above — a member must not curate another member's timeline.
  const project = await loadProjectForWrite(projectId);
  if (!project) return notFound();
  if (!canRestore(user, project.ownerId)) return forbidden();

  const checkpoint = await prisma.checkpoint.findFirst({
    where: { id: checkpointId, projectId },
  });
  if (!checkpoint) return { ok: false as const, error: 'Checkpoint not found', status: 404 };

  const updated = await prisma.checkpoint.update({
    where: { id: checkpointId },
    data: { isBookmarked: !checkpoint.isBookmarked },
  });
  return { ok: true as const, data: toPublic(updated) };
}
