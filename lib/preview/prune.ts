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
      // `normalizeKey` throws on a key it cannot resolve (it used to silently rewrite), so an
      // unguarded loop let one poisoned stored key abort the whole prune run, skip every
      // remaining project, and repeat on every tick. One bad key costs one object. The
      // listing is inside the guard too: `storagePrefix` is stored data, so it can be
      // un-normalizable in exactly the same way as the keys under it.
      const failedKeys: string[] = [];
      if (row.storagePrefix) {
        let keys: string[] = [];
        try {
          keys = await listKeys(row.storagePrefix);
        } catch (error) {
          failedKeys.push(row.storagePrefix);
          console.warn('[prune-previews] prefix listing failed', row.id, row.storagePrefix, error);
        }
        for (const key of keys) {
          try {
            await deleteObject(key);
          } catch (error) {
            failedKeys.push(key);
            console.warn('[prune-previews] object delete failed', row.id, key, error);
          }
        }
      }
      if (failedKeys.length > 0) {
        // The row is the only pointer to `storagePrefix`, so dropping it would orphan the
        // bytes with nothing in the product naming them. Keep it and retry next run.
        console.warn('[prune-previews] objects still present, keeping build row', {
          previewBuildId: row.id,
          failed: failedKeys.length,
        });
        continue;
      }
      await table.delete({ where: { id: row.id } });
      await adjustStorageBytes(-row.totalBytes);
      deleted += 1;
      reclaimedBytes += row.totalBytes;
    }
  }

  return { deleted, reclaimedBytes };
}
