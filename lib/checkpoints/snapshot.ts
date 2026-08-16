import { prisma } from '@/lib/db';
import { getCurrentProjectFiles } from '@/lib/github/current-files';

export type FileSnapshotEntry = { path: string; content: string };

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

export function asFileSnapshot(value: unknown): FileSnapshotEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as { path?: unknown; content?: unknown };
    if (typeof row.path !== 'string' || typeof row.content !== 'string') return [];
    return [{ path: row.path, content: row.content }];
  });
}
