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

/**
 * The current site did not build, so an earlier one that did is being served instead.
 *
 * Named separately from {@link PreviewedVersion} because the two are not the same event and
 * must not read as one. A preview is something the user asked for and can leave; this is the
 * product declining to show them the thing they just asked for, and the copy has to say so.
 */
export type HeldBackVersion = {
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
      /** Null unless the current files failed validation and a proven-good one was found. */
      heldBack: HeldBackVersion | null;
    }
  | { ok: false; error: string; status: number };

const STORAGE_UNAVAILABLE =
  'Could not read this version from storage. Your current version is untouched — try again in a moment.';

const VERSION_GONE =
  'This version’s snapshot is no longer available. Return to the current version to keep working.';

export async function servedProjectFiles(project: {
  id: string;
  lastCode: string | null;
  /**
   * The build verdict stored beside `lastCode`. Optional so the many callers that only
   * needed the files keep compiling; absent reads as `null`, which is "never checked".
   */
  lastCodeValidated?: boolean | null;
}): Promise<ServedFiles> {
  const previewingCheckpointId = await readPreviewingCheckpointId(project.id);
  if (!previewingCheckpointId) {
    // An explicitly chosen preview outranks the hold-back — the user asked for a specific
    // version and is looking at a banner that says so — which is why this branch runs only
    // when there is no preview in effect.
    const heldBack = await heldBackFiles(project);
    if (heldBack) return heldBack;
    return { ok: true, files: getCurrentProjectFiles(project), previewing: null, heldBack: null };
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
    heldBack: null,
  };
}

/**
 * The last version proven to build, when the current one is proven not to — and `null` in
 * every other case, including every case where the answer is merely unknown.
 *
 * The repair loop writes each failed attempt straight into `Project.lastCode`, so without
 * this the workspace preview compiles the broken attempt and shows it for as long as the loop
 * runs. On an edit to a working site that is worse than what the person had before they
 * typed: they asked for a change and the site they already had disappeared.
 *
 * Three conditions, all required, none of them inferred:
 *
 * 1. the current files are **known** broken (`lastCodeValidated === false`), not merely
 *    unchecked — `null` is what every row written before this column existed carries, and
 *    reading it as "broken" would hold back sites that are perfectly fine;
 * 2. there is an earlier snapshot **known** good, for the mirror-image reason;
 * 3. that snapshot can actually be read.
 *
 * Any of them missing and the live files are served exactly as before. A hold-back that
 * cannot name what it is holding back to is not a safety feature, it is a blank screen.
 */
async function heldBackFiles(project: {
  id: string;
  lastCodeValidated?: boolean | null;
}): Promise<Extract<ServedFiles, { ok: true }> | null> {
  if (project.lastCodeValidated !== false) return null;

  const good = await prisma.checkpoint.findFirst({
    where: { projectId: project.id, snapshotValidated: true, snapshotPruned: false },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      label: true,
      createdAt: true,
      snapshotPruned: true,
      snapshotKey: true,
      fileSnapshot: true,
    },
  });
  if (!good) return null;

  let entries;
  try {
    entries = await readSnapshot(good);
  } catch (error) {
    // Unlike the preview branch above, an unreadable snapshot here is not an error the user
    // has to act on: nobody asked to see this version. Falling through to the live files is
    // the honest outcome — they are what the project actually holds — so the failure is
    // logged and the caller carries on.
    if (error instanceof SnapshotReadError) {
      console.error('[checkpoints] held-back snapshot read failed', error);
      return null;
    }
    throw error;
  }
  if (entries.length === 0) return null;

  return {
    ok: true,
    files: Object.fromEntries(entries.map((entry) => [entry.path, entry.content])),
    previewing: null,
    heldBack: {
      checkpointId: good.id,
      label: good.label,
      createdAt: good.createdAt.toISOString(),
    },
  };
}
