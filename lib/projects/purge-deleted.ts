import { prisma } from '@/lib/db';
import { deleteObject, listKeys } from '@/lib/storage';
import { adjustStorageBytes } from '@/lib/storage/usage';
import { purgeDeletedDays } from '@/lib/checkpoints/retention';
import { writeAudit } from '@/lib/audit/log';
import { purgeProjectPublishResources } from '@/lib/publish/cleanup';
import type { PurgedProjectPublishResources } from '@/lib/publish/cleanup';

/**
 * Hard-deletes soft-deleted projects past the retention window.
 *
 * Order matters, and it is the reverse of what it used to be. `Job.project` is
 * `onDelete: Cascade`, so `prisma.project.delete` takes every PUBLISH job's `resourceIds`
 * with it — and those are the creation receipts the orphan cron needs, because it will only
 * delete a cloud resource whose id this system recorded creating (name-shape deletion is not
 * coming back: it deleted operators' `www`, `api` and `mail` records). The old order tore
 * publish resources down inside a try/catch that only warned, then deleted the Project
 * regardless, so a Coolify 502 left a container running and billing whose uuid existed in no
 * Deployment row and no Job row. Nothing could ever reap it.
 *
 * Now a project is only deleted once every provider has confirmed its resources are gone.
 * Anything still live blocks the delete, keeps its receipts, and is retried on the next run —
 * see `blocked` in the return value. The ids are also copied into the `project.hard_purge`
 * audit entry before the delete, which is the one receipt that outlives the cascade.
 */
export async function purgeDeletedProjects() {
  const days = await purgeDeletedDays();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const projects = await prisma.project.findMany({
    where: { deletedAt: { not: null, lt: cutoff } },
    select: {
      id: true,
      checkpoints: { select: { snapshotKey: true, snapshotBytes: true } },
      projectAssets: { select: { storageKey: true, sizeBytes: true } },
      // `storagePrefix` is the only pointer to `previews/{id}/{buildId}/…`
      // objects, and the delete below cascades these rows away — so this
      // listing is the last moment the bytes can be reclaimed at all.
      previewBuilds: { select: { totalBytes: true } },
    },
  });

  let purged = 0;
  let reclaimedBytes = 0;
  let blocked = 0;

  for (const project of projects) {
    // Publish resources first: they are the ones that keep costing the operator money, and
    // the whole per-project unit is abandoned if they are not gone, so nothing may be
    // destroyed before they are. Also keeps `adjustStorageBytes` from double-counting a
    // project that gets retried.
    let publish: PurgedProjectPublishResources;
    try {
      publish = await purgeProjectPublishResources(project.id);
    } catch (error) {
      console.warn('[purge-projects] publish cleanup failed', project.id, error);
      blocked += 1;
      continue;
    }
    if (publish.failures.length > 0) {
      console.warn('[purge-projects] publish resources still live, retrying next run', {
        projectId: project.id,
        failures: publish.failures,
      });
      blocked += 1;
      continue;
    }

    // Guarded like the deletes below. Skipping one project has to be cheaper than skipping
    // every project behind it in the loop, and a project whose deployments are already torn
    // down is safe to retry: `purgeProjectPublishResources` finds no rows and reports none.
    let listed: string[];
    try {
      listed = [
        ...(await listKeys(`snapshots/${project.id}/`)),
        ...(await listKeys(`projects/${project.id}/`)),
        ...(await listKeys(`previews/${project.id}/`)),
      ];
    } catch (error) {
      console.warn('[purge-projects] object listing failed', project.id, error);
      blocked += 1;
      continue;
    }
    const keys = new Set<string>([
      ...listed,
      ...project.checkpoints.flatMap((row) => (row.snapshotKey ? [row.snapshotKey] : [])),
      ...project.projectAssets.map((row) => row.storageKey),
    ]);

    // `normalizeKey` throws on a key it cannot resolve (it used to silently rewrite), and the
    // set mixes listed keys with stored `snapshotKey`/`storageKey` values that an older build
    // or a manual fix could have written in a shape it refuses. Unguarded, one such key
    // aborted the whole run, skipped every remaining project, and repeated on every tick.
    // One poisoned key must cost one object, not the run.
    const failedKeys: string[] = [];
    for (const key of keys) {
      try {
        await deleteObject(key);
      } catch (error) {
        failedKeys.push(key);
        console.warn('[purge-projects] object delete failed', project.id, key, error);
      }
    }
    if (failedKeys.length > 0) {
      // Same rule as the publish resources: the rows naming these objects are the only way
      // back to them, so leave the project for the next run rather than orphaning the bytes.
      console.warn('[purge-projects] objects still present, retrying next run', {
        projectId: project.id,
        failed: failedKeys.length,
      });
      blocked += 1;
      continue;
    }

    const bytes =
      project.checkpoints.reduce((sum, row) => sum + (row.snapshotBytes ?? 0), 0) +
      project.projectAssets.reduce((sum, row) => sum + row.sizeBytes, 0) +
      // `totalBytes` is the pre-gzip sum the build recorded; the writer
      // incremented per uploaded (possibly gzipped) body, so this can reclaim
      // slightly more than was added. `adjustStorageBytes` clamps the ledger
      // at zero, and over-reclaiming a few percent beats never subtracting.
      project.previewBuilds.reduce((sum, row) => sum + row.totalBytes, 0);

    // Written *before* the delete, on purpose. The cascade below destroys the Deployment and
    // PUBLISH job rows, so this entry becomes the only record naming these ids — the orphan
    // cron reads it back as provenance, which is what lets it reap a resource the provider
    // reported gone but kept alive. Ids and repo names only; nothing here is a secret.
    await writeAudit({
      actorEmail: 'system@navroop.local',
      action: 'project.hard_purge',
      targetType: 'project',
      targetId: project.id,
      after: {
        deployments: publish.resources,
        keptCloudflareZones: publish.keptCloudflareZones,
        reclaimedBytes: bytes,
      },
    });

    await prisma.project.delete({ where: { id: project.id } });
    await adjustStorageBytes(-bytes);

    console.info('[purge-projects]', { projectId: project.id, reclaimedBytes: bytes });
    purged += 1;
    reclaimedBytes += bytes;
  }

  console.info('[purge-projects] done', { purged, blocked, reclaimedBytes, days });
  return { purged, blocked, reclaimedBytes, days };
}
