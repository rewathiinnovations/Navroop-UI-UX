export type PreviewBuildRetentionRow = {
  id: string;
  createdAt: Date;
  checkpointId: string;
  storagePrefix?: string | null;
};

export function previewBuildsToDelete(
  builds: PreviewBuildRetentionRow[],
  options: {
    activeId: string | null;
    bookmarkedCheckpointIds: string[];
    keepRecent?: number;
  },
) {
  const keepRecent = options.keepRecent ?? 2;
  const bookmarked = new Set(options.bookmarkedCheckpointIds);
  const keep = new Set<string>();
  if (options.activeId) keep.add(options.activeId);

  const newestFirst = [...builds].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  let keptRecent = 0;
  for (const row of newestFirst) {
    if (keep.has(row.id)) continue;
    if (bookmarked.has(row.checkpointId)) {
      keep.add(row.id);
      continue;
    }
    if (keptRecent < keepRecent) {
      keep.add(row.id);
      keptRecent += 1;
    }
  }

  return builds.filter((row) => !keep.has(row.id)).map((row) => row.id);
}
