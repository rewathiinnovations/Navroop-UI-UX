import { prisma } from '@/lib/db';
import { captureFileSnapshot, readSnapshot, SnapshotReadError } from '@/lib/checkpoints/snapshot';
import type { JobErrorCode } from '@/lib/jobs/types';
import { PublishRepoConflictError } from './repo-guard';

export function publishJobErrorCode(error: unknown): JobErrorCode {
  if (error instanceof SnapshotReadError) return 'snapshot_unreadable';
  if (error instanceof PublishRepoConflictError) return 'repo_conflict';
  return 'provider_error';
}

function toMap(entries: Array<{ path: string; content: string }>) {
  const files: Record<string, string> = {};
  for (const entry of entries) {
    const path = entry.path.replace(/^\.?\//, '');
    if (!path || path.startsWith('.git/')) continue;
    files[path] = entry.content;
  }
  return files;
}

/**
 * Publish files from the latest Checkpoint, else the project's stored code.
 *
 * There is no live sandbox to read any more: the project's files live in the
 * database and are rendered in the browser, so the newest snapshot is the
 * newest site.
 */
export async function collectPublishFiles(projectId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId },
    select: { id: true, stack: true, lastCode: true },
  });
  if (!project) {
    throw new Error('Project not found');
  }

  const latest = await prisma.checkpoint.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    select: { snapshotKey: true, fileSnapshot: true },
  });
  // Propagates SnapshotReadError on purpose: a storage failure must not fall through
  // to captureFileSnapshot, which reads project.lastCode and would ship a stale site
  // under a green publish job. Do not add a catch that returns the fallback.
  const fromCheckpoint = latest ? await readSnapshot(latest) : [];
  if (fromCheckpoint.length > 0) return toMap(fromCheckpoint);

  const fallback = await captureFileSnapshot(projectId);
  if (fallback.length > 0) return toMap(fallback);

  throw new Error('This project has no files to publish');
}

export const PUBLISH_FILES_UNAVAILABLE =
  "We could not read this project's files from storage. Try again in a few minutes.";

/**
 * Whether the UI may offer Publish. `unavailable` is a storage failure — not "ready"
 * and not "no files". Callers must switch on `status`; do not coerce this to a boolean
 * (`'unavailable'` is truthy and would offer Publish).
 */
export type PublishableFilesState =
  { status: 'ready' } | { status: 'empty' } | { status: 'unavailable'; reason: string };

export async function projectHasPublishableFiles(
  projectId: string,
): Promise<PublishableFilesState> {
  try {
    await collectPublishFiles(projectId);
    return { status: 'ready' };
  } catch (error) {
    if (error instanceof Error && error.message === 'This project has no files to publish') {
      return { status: 'empty' };
    }
    if (error instanceof Error && error.message === 'Project not found') {
      return { status: 'empty' };
    }
    if (error instanceof SnapshotReadError) {
      return { status: 'unavailable', reason: PUBLISH_FILES_UNAVAILABLE };
    }
    throw error;
  }
}
