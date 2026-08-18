import { prisma } from '@/lib/db';
import { deleteObject } from '@/lib/storage';
import { adjustStorageBytes } from '@/lib/storage/usage';
import { checkpointRetentionDays, isThinEligible } from './retention';
import { pruneStalePresence } from '@/lib/projects/presence';

export async function thinCheckpoints() {
  const retentionDays = checkpointRetentionDays();
  const now = new Date();
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  const latestRows = await prisma.checkpoint.groupBy({
    by: ['projectId'],
    _max: { createdAt: true },
  });
  const latestAt = new Map(
    latestRows.map((row) => [row.projectId, row._max.createdAt?.getTime() ?? 0]),
  );

  const candidates = await prisma.checkpoint.findMany({
    where: {
      isBookmarked: false,
      snapshotPruned: false,
      createdAt: { lt: cutoff },
      snapshotKey: { not: null },
    },
    select: {
      id: true,
      projectId: true,
      createdAt: true,
      isBookmarked: true,
      snapshotPruned: true,
      snapshotKey: true,
      snapshotBytes: true,
    },
  });

  let thinned = 0;
  let reclaimedBytes = 0;

  for (const row of candidates) {
    const latestCreatedAt = latestAt.get(row.projectId);
    const latestId = latestCreatedAt === row.createdAt.getTime() ? row.id : 'other';
    if (
      !isThinEligible({
        id: row.id,
        latestId,
        createdAt: row.createdAt,
        isBookmarked: row.isBookmarked,
        snapshotPruned: row.snapshotPruned,
        now,
        retentionDays,
      })
    ) {
      continue;
    }

    if (row.snapshotKey) {
      await deleteObject(row.snapshotKey);
    }
    await prisma.checkpoint.update({
      where: { id: row.id },
      data: { snapshotKey: null, snapshotPruned: true },
    });
    const bytes = row.snapshotBytes ?? 0;
    await adjustStorageBytes(-bytes);
    thinned += 1;
    reclaimedBytes += bytes;
  }

  const presence = await pruneStalePresence();
  const { pruneAuditLogs } = await import('@/lib/audit/log');
  const audit = await pruneAuditLogs();
  const { prunePreviewBuilds } = await import('@/lib/preview/prune');
  const preview = await prunePreviewBuilds();
  console.info('[thin-checkpoints]', {
    thinned,
    reclaimedBytes,
    retentionDays,
    presencePruned: presence.pruned,
    auditPruned: audit.deleted,
    previewDeleted: preview.deleted,
    previewReclaimedBytes: preview.reclaimedBytes,
  });
  return {
    thinned,
    reclaimedBytes,
    retentionDays,
    presencePruned: presence.pruned,
    auditPruned: audit.deleted,
    previewDeleted: preview.deleted,
    previewReclaimedBytes: preview.reclaimedBytes,
  };
}
