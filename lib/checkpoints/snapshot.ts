import { prisma } from '@/lib/db';
import { getCurrentProjectFiles } from '@/lib/github/current-files';
import { asFileSnapshot, type FileSnapshotEntry } from './snapshot-store';

export type { FileSnapshotEntry, SnapshotRecord, WriteSnapshotResult } from './snapshot-store';
export {
  asFileSnapshot,
  readSnapshot,
  snapshotObjectKey,
  SnapshotReadError,
  writeSnapshot,
} from './snapshot-store';

/** Same file-tree helper GitHub push uses. Do not add a second reader. */
export async function captureFileSnapshot(projectId: string): Promise<FileSnapshotEntry[]> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { lastCode: true },
  });
  const files = getCurrentProjectFiles({ lastCode: project?.lastCode });
  return Object.entries(files)
    .map(([path, content]) => ({ path, content }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function snapshotsEqual(left: unknown, right: FileSnapshotEntry[]) {
  const normalized = asFileSnapshot(left);
  if (normalized.length !== right.length) return false;
  return normalized.every((entry, index) => {
    const other = right[index];
    return entry.path === other.path && entry.content === other.content;
  });
}

