import { readSnapshot, type FileSnapshotEntry } from '@/lib/checkpoints/snapshot-store';
import { filterExportFiles, type OversizedExportFile } from './files';

export type ExportCheckpoint = {
  id: string;
  snapshotKey?: string | null;
  fileSnapshot?: unknown;
  createdAt: Date;
};

/**
 * Collect files from a checkpoint snapshot. The sandbox is never consulted —
 * a DEAD sandbox must not block export, and there is no `sandboxStatus`
 * parameter for that reason: it used to be accepted and immediately `void`ed
 * (F-770), so every caller computed and passed a value that could not affect
 * the result while the signature advertised a dependency this export
 * deliberately does not have.
 *
 * Propagates `SnapshotReadError` on purpose: the route turns an empty result into a 409
 * "No checkpoint files to export", but it streams whatever it is handed, so swallowing a
 * storage failure here would hand the user a successful download of an empty ZIP. Do not
 * add a catch that returns `[]`.
 */
export async function collectExportFiles(input: {
  projectId: string;
  checkpointId?: string | null;
  checkpoints: ExportCheckpoint[];
}): Promise<{ files: FileSnapshotEntry[]; oversized: OversizedExportFile[] }> {
  const selected = input.checkpointId
    ? input.checkpoints.find((row) => row.id === input.checkpointId)
    : [...input.checkpoints].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

  if (!selected) {
    // No checkpoint exists — a build whose post-generation capture failed
    // (dead sandbox at that moment) still has its finished site in lastCode.
    // The boot restore already treats lastCode as the snapshot fallback; the
    // user's "Download code" gets the same site instead of a refusal. An
    // explicitly requested checkpoint id is still answered from checkpoints
    // only (the route 404s before this on an unknown id).
    if (!input.checkpointId) {
      const { captureFileSnapshot } = await import('@/lib/checkpoints/snapshot');
      return filterExportFiles(await captureFileSnapshot(input.projectId));
    }
    return { files: [], oversized: [] };
  }
  const files = await readSnapshot({
    snapshotKey: selected.snapshotKey,
    fileSnapshot: selected.fileSnapshot,
  });
  return filterExportFiles(files);
}
