import { readSnapshot, type FileSnapshotEntry } from '@/lib/checkpoints/snapshot-store';
import { filterExportFiles } from './files';

export type ExportCheckpoint = {
  id: string;
  snapshotKey?: string | null;
  fileSnapshot?: unknown;
  createdAt: Date;
};

/**
 * Collect files from a checkpoint snapshot. The sandbox is never consulted —
 * a DEAD sandbox must not block export.
 *
 * Propagates `SnapshotReadError` on purpose: the route turns an empty result into a 409
 * "No checkpoint files to export", but it streams whatever it is handed, so swallowing a
 * storage failure here would hand the user a successful download of an empty ZIP. Do not
 * add a catch that returns `[]`.
 */
export async function collectExportFiles(input: {
  projectId: string;
  checkpointId?: string | null;
  sandboxStatus?: string | null;
  checkpoints: ExportCheckpoint[];
}): Promise<FileSnapshotEntry[]> {
  void input.projectId;
  void input.sandboxStatus;

  const selected = input.checkpointId
    ? input.checkpoints.find((row) => row.id === input.checkpointId)
    : [...input.checkpoints].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

  if (!selected) return [];
  const files = await readSnapshot({
    snapshotKey: selected.snapshotKey,
    fileSnapshot: selected.fileSnapshot,
  });
  return filterExportFiles(files);
}
