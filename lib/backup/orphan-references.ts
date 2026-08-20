import { prisma } from '@/lib/db';
import { ORPHAN_SCOPES, storageKeyFromUrl, type OrphanReferences } from './orphans';

/**
 * Everything the database claims to own, per storage prefix — the other half of the orphan
 * diff in `./orphans.ts`, kept in its own module so that file stays free of `lib/db` and can
 * be exercised without a Prisma client.
 *
 * A row is a reference only while it still points at the object: a checkpoint whose snapshot
 * was pruned is deliberately excluded, so an object left behind by a prune whose delete failed
 * shows up as reclaimable instead of hiding behind its own row forever.
 *
 * These are `select`ed columns of whole tables. That is the point — the diff is only sound if
 * the reference set is complete, so it cannot be paged. The columns are small (one key or URL
 * per row) and this runs once a week.
 */
export async function loadOrphanReferences(): Promise<Map<string, OrphanReferences>> {
  const references = new Map<string, OrphanReferences>(
    ORPHAN_SCOPES.map((scope) => [scope.prefix, { keys: new Set<string>(), prefixes: [] }]),
  );
  const add = (prefix: string, key: string | null) => {
    if (key) references.get(prefix)?.keys.add(key);
  };

  const [checkpoints, assets, previews, users, templates] = await Promise.all([
    prisma.checkpoint.findMany({
      where: { snapshotPruned: false },
      select: { snapshotKey: true, thumbnailUrl: true },
    }),
    prisma.projectAsset.findMany({ select: { storageKey: true } }),
    prisma.previewBuild.findMany({
      where: { storagePrefix: { not: null } },
      select: { storagePrefix: true },
    }),
    prisma.user.findMany({ where: { avatarUrl: { not: null } }, select: { avatarUrl: true } }),
    prisma.template.findMany({
      where: { thumbnailKey: { not: null } },
      select: { thumbnailKey: true },
    }),
  ]);

  for (const row of checkpoints) {
    add('snapshots/', row.snapshotKey);
    // Checkpoint thumbnails are written with `assetStorageKey`, so they land under
    // `projects/` next to generated images and only the URL is stored.
    add('projects/', storageKeyFromUrl(row.thumbnailUrl));
  }
  for (const row of assets) add('projects/', row.storageKey);
  for (const row of users) add('users/', storageKeyFromUrl(row.avatarUrl));
  for (const row of templates) add('templates/', row.thumbnailKey);

  const previewScope = references.get('previews/');
  if (previewScope) {
    for (const row of previews) {
      if (row.storagePrefix) previewScope.prefixes.push(row.storagePrefix);
    }
  }

  return references;
}
