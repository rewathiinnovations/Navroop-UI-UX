import { prisma } from '@/lib/db';
import { getSessionUser, type SessionUser } from '@/lib/auth';
import { peekActor } from '@/lib/projects/plan';
import {
  asFileSnapshot,
  captureFileSnapshot,
  snapshotsEqual,
  type FileSnapshotEntry,
} from './snapshot';
import { captureThumbnail } from './thumbnail';
import { writeSnapshotToSandbox } from './write-sandbox';

export type CheckpointTrigger = 'initial' | 'followup' | 'restore';

export type PublicCheckpoint = {
  id: string;
  label: string;
  thumbnailUrl: string | null;
  createdAt: string;
  trigger: CheckpointTrigger;
  sourceMessage: string | null;
};

type ActionErr = { ok: false; error: string; status: number };
type ActionOk<T> = { ok: true; data: T };

function unauthorized(): ActionErr {
  return { ok: false, error: 'Sign in required', status: 401 };
}

function notFound(): ActionErr {
  return { ok: false, error: 'Project not found', status: 404 };
}

function forbidden(): ActionErr {
  return { ok: false, error: 'Forbidden', status: 403 };
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

function lastConversationUserMessage() {
  const messages = (
    globalThis as {
      conversationState?: { context?: { messages?: { role?: string; content?: string }[] } };
    }
  ).conversationState?.context?.messages;
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
}): PublicCheckpoint {
  return {
    id: row.id,
    label: row.label,
    thumbnailUrl: row.thumbnailUrl,
    createdAt: row.createdAt.toISOString(),
    trigger: row.trigger === 'restore' ? 'restore' : row.trigger === 'followup' ? 'followup' : 'initial',
    sourceMessage: row.sourceMessage,
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
    thumbnailUrl = await captureThumbnail(input.previewUrl);
  } catch (error) {
    console.warn('[checkpoints] thumbnail failed', error);
  }

  const created = await prisma.checkpoint.create({
    data: {
      projectId,
      label,
      sourceMessage: input.sourceMessage ?? null,
      trigger: input.trigger,
      fileSnapshot,
      thumbnailUrl,
    },
  });

  if (thumbnailUrl) {
    await prisma.project.update({
      where: { id: projectId },
      data: { thumbnailUrl },
    });
  }

  return created;
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
  let sourceMessage = input.sourceMessage ?? lastConversationUserMessage();

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
  if (snapshot.length === 0) {
    throw new Error('Cannot create checkpoint: file snapshot is empty');
  }

  const latest = await prisma.checkpoint.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    select: { fileSnapshot: true },
  });
  if (latest && snapshotsEqual(latest.fileSnapshot, snapshot)) {
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
    },
  });

  return { ok: true as const, data: rows.map(toPublic) };
}

async function loadProjectForWrite(projectId: string) {
  return prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, ownerId: true, sandboxId: true, previewUrl: true },
  });
}

async function writeCheckpointFiles(projectId: string, snapshot: unknown, sandboxId?: string | null) {
  const files: FileSnapshotEntry[] = asFileSnapshot(snapshot);
  if (files.length === 0) {
    throw new Error('Checkpoint has no files to write');
  }
  await writeSnapshotToSandbox(projectId, files, sandboxId);
}

export async function previewCheckpoint(projectId: string, checkpointId: string) {
  const { user, err } = await requireActor();
  if (!user) return err;

  const project = await loadProjectForWrite(projectId);
  if (!project) return notFound();

  const checkpoint = await prisma.checkpoint.findFirst({
    where: { id: checkpointId, projectId },
  });
  if (!checkpoint) return { ok: false as const, error: 'Checkpoint not found', status: 404 };

  await writeCheckpointFiles(projectId, checkpoint.fileSnapshot, project.sandboxId);
  return { ok: true as const, data: toPublic(checkpoint) };
}

export async function exitCheckpointPreview(projectId: string) {
  const { user, err } = await requireActor();
  if (!user) return err;

  const project = await loadProjectForWrite(projectId);
  if (!project) return notFound();

  const latest = await prisma.checkpoint.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
  });
  if (!latest) {
    return { ok: false as const, error: 'No current checkpoint to restore', status: 409 };
  }

  await writeCheckpointFiles(projectId, latest.fileSnapshot, project.sandboxId);
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

  await writeCheckpointFiles(projectId, checkpoint.fileSnapshot, project.sandboxId);

  const created = await createCheckpoint(projectId, {
    trigger: 'restore',
    sourceMessage: null,
    previewUrl: project.previewUrl,
    restoredFromAt: checkpoint.createdAt,
  });

  return { ok: true as const, data: toPublic(created) };
}
