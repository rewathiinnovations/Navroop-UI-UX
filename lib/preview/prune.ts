import { prisma } from '@/lib/db';
import { deleteObject, listKeys } from '@/lib/storage';
import { adjustStorageBytes } from '@/lib/storage/usage';
import { previewBuildTable } from './db';
import { previewBuildsToDelete } from './retention';

export async function prunePreviewBuilds() {
  const table = previewBuildTable();
  const projects = await prisma.project.findMany({
    where: { deletedAt: null },
    select: { id: true },
  });

  let deleted = 0;
  let reclaimedBytes = 0;

  for (const project of projects) {
    const [builds, bookmarked] = await Promise.all([
      table.findMany({
        where: { projectId: project.id },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.checkpoint.findMany({
        where: { projectId: project.id, isBookmarked: true },
        select: { id: true },
      }),
    ]);
    const previewFields = await prisma.$queryRaw<Array<{ activePreviewBuildId: string | null }>>`
      SELECT "activePreviewBuildId" FROM "Project" WHERE id = ${project.id} LIMIT 1
    `;
    const removeIds = new Set(
      previewBuildsToDelete(
        builds.map((row) => ({
          id: row.id,
          createdAt: row.createdAt,
          checkpointId: row.checkpointId,
          storagePrefix: row.storagePrefix,
        })),
        {
          activeId: previewFields[0]?.activePreviewBuildId ?? null,
          bookmarkedCheckpointIds: bookmarked.map((row) => row.id),
          keepRecent: 2,
        },
      ),
    );

    for (const row of builds) {
      if (!removeIds.has(row.id)) continue;
      if (row.storagePrefix) {
        const keys = await listKeys(row.storagePrefix);
        for (const key of keys) {
          await deleteObject(key);
        }
      }
      await table.delete({ where: { id: row.id } });
      await adjustStorageBytes(-row.totalBytes);
      deleted += 1;
      reclaimedBytes += row.totalBytes;
    }
  }

  return { deleted, reclaimedBytes };
}
