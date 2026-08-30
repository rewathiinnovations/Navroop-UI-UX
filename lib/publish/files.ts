import { prisma } from '@/lib/db';
import { captureFileSnapshot, readSnapshot, SnapshotReadError } from '@/lib/checkpoints/snapshot';
import type { JobErrorCode } from '@/lib/jobs/types';
import { PublishAssetError } from './assets';
import { PushRefusedError } from '@/lib/github/push-limits';
import { PublishRepoConflictError } from './repo-guard';

export function publishJobErrorCode(error: unknown): JobErrorCode {
  if (error instanceof SnapshotReadError) return 'snapshot_unreadable';
  if (error instanceof PublishRepoConflictError) return 'repo_conflict';
  if (error instanceof PublishAssetError) return 'asset_unpublishable';
  // A leaf import: `lib/github/push-limits.ts` holds the guards and the error, so mapping
  // the refusal here does not pull the whole deploy client (and its fetch and crypto) in.
  if (error instanceof PushRefusedError) return 'push_refused';
  return 'provider_error';
}

/**
 * Paths that must never reach a deploy repo (F-201). The commit is built from
 * explicit Git Data tree entries, so a `.gitignore` in the tree is decoration —
 * the only place an exclusion can work is here, before a file becomes a commit.
 * Both sources (checkpoint snapshot and stored-code fallback) flow through
 * `toMap`, so both are covered.
 */
function isNeverPublishedPath(path: string): boolean {
  const segments = path.split('/');
  if (segments.some((segment) => segment === 'node_modules' || segment === '.git')) return true;
  const basename = (segments[segments.length - 1] ?? '').toLowerCase();
  if (basename === '.env') return true;
  if (basename.startsWith('.env.') && basename !== '.env.example') return true;
  if (basename.endsWith('.pem')) return true;
  if (basename.startsWith('id_rsa')) return true;
  return false;
}

/**
 * Drop every never-publish path from a finished file set.
 *
 * `toMap` applies the same rule to each source as it is read; this applies it to the set
 * that is actually about to become a commit, after the stack scaffold and the host files
 * have been laid under and over it and the project's images beside it. Publish calls it
 * there because `collectFiles` is an injectable dependency and the commit is built from
 * explicit Git Data tree entries — a `.gitignore` inside the tree is decoration, so the
 * filter has to be the last thing that runs, not something a caller can bypass.
 *
 * Generic in the entry type because that final set is no longer all text: a published
 * image is bytes, and the deny list is about the path either way.
 */
export function withoutNeverPublishedPaths<T>(files: Record<string, T>) {
  const kept: Record<string, T> = {};
  for (const [path, content] of Object.entries(files)) {
    if (!isNeverPublishedPath(path)) kept[path] = content;
  }
  return kept;
}

function toMap(entries: Array<{ path: string; content: string }>) {
  const files: Record<string, string> = {};
  for (const entry of entries) {
    const path = entry.path.replace(/^\.?\//, '');
    if (!path || isNeverPublishedPath(path)) continue;
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
  if (fromCheckpoint.length > 0) {
    // No fallback when everything was excluded: shipping lastCode instead of the
    // checkpoint the user believes they are publishing would be a stale site.
    const files = toMap(fromCheckpoint);
    if (Object.keys(files).length === 0) throw new Error('This project has no files to publish');
    return files;
  }

  const fallback = await captureFileSnapshot(projectId);
  if (fallback.length > 0) {
    const files = toMap(fallback);
    if (Object.keys(files).length === 0) throw new Error('This project has no files to publish');
    return files;
  }

  throw new Error('This project has no files to publish');
}

export const PUBLISH_FILES_UNAVAILABLE =
  "We could not read this project's files from storage. Try again in a few minutes.";

export const PUBLISH_FILES_BROKEN =
  'The current version does not build. Fix it or restore an earlier version, then publish.';

/**
 * The stored verdict says this project's current files do not compile.
 *
 * Deliberately *not* folded into {@link projectHasPublishableFiles}. That function answers
 * "are there files to work with", and its other two callers are the code audit and the SEO
 * scan — the two things a person most wants to run on a site that does not build. Only
 * publishing has to refuse, because only publishing puts the result in someone else's
 * repository, so only publishing asks.
 *
 * Only a recorded `false` counts. `null` is every row written before the column existed and
 * every write that is not a generation; refusing to publish on an absence of evidence would
 * take the button away from projects that work perfectly well.
 */
export async function siteFailsToBuild(projectId: string): Promise<boolean> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { lastCodeValidated: true },
  });
  return project?.lastCodeValidated === false;
}

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
