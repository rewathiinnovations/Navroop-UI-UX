import { prisma } from '@/lib/db';
import { deleteObject, listKeys } from '@/lib/storage';
import { adjustStorageBytes } from '@/lib/storage/usage';
import { purgeDeletedDays } from '@/lib/checkpoints/retention';

async function killProjectSandbox(projectId: string, sandboxId: string | null) {
  if (!sandboxId) return;
  try {
    const mod = await import('@/lib/sandbox/manager');
    if (typeof mod.killSandbox === 'function') {
      await mod.killSandbox(projectId);
    }
  } catch (error) {
    console.warn('[purge-projects] killSandbox skipped', projectId, error);
  }
}

export async function purgeDeletedProjects() {
  const days = purgeDeletedDays();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const projects = await prisma.project.findMany({
    where: { deletedAt: { not: null, lt: cutoff } },
    select: {
      id: true,
      sandboxId: true,
      checkpoints: { select: { snapshotKey: true, snapshotBytes: true } },
      projectAssets: { select: { storageKey: true, sizeBytes: true } },
    },
  });

  let purged = 0;
  let reclaimedBytes = 0;

  for (const project of projects) {
    const listed = [
      ...(await listKeys(`snapshots/${project.id}/`)),
      ...(await listKeys(`projects/${project.id}/`)),
    ];
    const keys = new Set<string>([
      ...listed,
      ...project.checkpoints.flatMap((row) => (row.snapshotKey ? [row.snapshotKey] : [])),
      ...project.projectAssets.map((row) => row.storageKey),
    ]);

    for (const key of keys) {
      await deleteObject(key);
    }

    const bytes =
      project.checkpoints.reduce((sum, row) => sum + (row.snapshotBytes ?? 0), 0) +
      project.projectAssets.reduce((sum, row) => sum + row.sizeBytes, 0);

    await killProjectSandbox(project.id, project.sandboxId);
    await prisma.project.delete({ where: { id: project.id } });
    await adjustStorageBytes(-bytes);

    console.info('[purge-projects]', { projectId: project.id, reclaimedBytes: bytes });
    purged += 1;
    reclaimedBytes += bytes;
  }

  console.info('[purge-projects] done', { purged, reclaimedBytes, days });
  return { purged, reclaimedBytes, days };
}
