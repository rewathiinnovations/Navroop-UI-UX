import { prisma } from '@/lib/db';
import { getCurrentProjectFiles } from '@/lib/github/current-files';
import { readSnapshot, SnapshotReadError } from './snapshot';
import { readPreviewingCheckpointId } from './preview-state';

/**
 * F-102: what the Code tab and the in-browser preview are served.
 *
 * This is the half that makes a non-destructive preview actually show something. "Preview
 * this version" no longer writes `Project.lastCode`; it records
 * `Project.previewingCheckpointId`, and the read path answers with that checkpoint's snapshot
 * instead. Publish, ZIP export and `createCheckpointAfterGeneration` all read `lastCode`
 * directly and are therefore unaffected by a preview — which is the entire point.
 *
 * Every failure is named. A preview whose snapshot cannot be read must not fall through to
 * the live files: the pane would say "viewing v3" over v9's content, which is the same
 * collapse of absent / unreadable / broken the audit found everywhere else. The caller shows
 * the message and the user leaves the preview.
 */

export type PreviewedVersion = {
  checkpointId: string;
  label: string;
  createdAt: string;
};

export type ServedFiles =
  | {
      ok: true;
      files: Record<string, string>;
      /** Null when the project is on its current version. */
      previewing: PreviewedVersion | null;
    }
  | { ok: false; error: string; status: number };

const STORAGE_UNAVAILABLE =
  'Could not read this version from storage. Your current version is untouched — try again in a moment.';

const VERSION_GONE =
  'This version’s snapshot is no longer available. Return to the current version to keep working.';

export async function servedProjectFiles(project: {
  id: string;
  lastCode: string | null;
}): Promise<ServedFiles> {
  const previewingCheckpointId = await readPreviewingCheckpointId(project.id);
  if (!previewingCheckpointId) {
    return { ok: true, files: getCurrentProjectFiles(project), previewing: null };
  }

  const checkpoint = await prisma.checkpoint.findFirst({
    where: { id: previewingCheckpointId, projectId: project.id },
    select: {
      id: true,
      label: true,
      createdAt: true,
      snapshotPruned: true,
      snapshotKey: true,
      fileSnapshot: true,
    },
  });
  // The flag points at a row that is not there. Distinct from a storage failure, and it is
  // not silently downgraded to "no preview": the workspace is still showing a preview banner,
  // so serving the live files under it would be a lie the user cannot see through.
  if (!checkpoint) return { ok: false, error: VERSION_GONE, status: 409 };
  if (checkpoint.snapshotPruned) return { ok: false, error: VERSION_GONE, status: 409 };

  let entries;
  try {
    entries = await readSnapshot(checkpoint);
  } catch (error) {
    if (error instanceof SnapshotReadError) {
      console.error('[checkpoints] preview snapshot read failed', error);
      return { ok: false, error: STORAGE_UNAVAILABLE, status: 503 };
    }
    throw error;
  }
  if (entries.length === 0) return { ok: false, error: VERSION_GONE, status: 409 };

  return {
    ok: true,
    files: Object.fromEntries(entries.map((entry) => [entry.path, entry.content])),
    previewing: {
      checkpointId: checkpoint.id,
      label: checkpoint.label,
      createdAt: checkpoint.createdAt.toISOString(),
    },
  };
}
