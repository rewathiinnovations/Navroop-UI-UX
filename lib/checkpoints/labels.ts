/**
 * What chat is told when a generation succeeded but its checkpoint did not write.
 *
 * The files are in `Project.lastCode` — the generation itself is fine — but the
 * checkpoint is the source of truth for a project with no sandbox: ZIP export, publish's
 * `collectPublishFiles`, and version restore all read it. A build that silently produced
 * no checkpoint used to report a clean completion (F-807); this says the snapshot is
 * missing without claiming the build failed.
 */
export const CHECKPOINT_NOT_SAVED_NOTICE =
  'Your changes are saved, but this version could not be added to version history. Export and rollback may be unavailable for it — generate again to create a new snapshot.';
