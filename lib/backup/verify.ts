import { prisma } from '@/lib/db';
import { exists, listKeys } from '@/lib/storage';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { finishBackupRun, startBackupRun } from './runs';

export async function runStorageVerify() {
  const run = await startBackupRun('storage_verify');
  try {
    const checkpoints = await prisma.checkpoint.findMany({
      where: { snapshotKey: { not: null }, snapshotPruned: false },
      select: { id: true, snapshotKey: true, snapshotBytes: true },
    });

    const missing: string[] = [];
    for (const row of checkpoints) {
      const key = row.snapshotKey;
      if (!key) continue;
      let ok: boolean;
      try {
        ok = await exists(key);
      } catch (error) {
        // A HEAD that failed is not proof the object is gone. Counting it as `missing`
        // would present rejected credentials or throttling on /admin/backups as backup
        // data loss, and the first response to that is a restore.
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Could not check snapshot storage (${key}): ${detail}. This is a storage failure, not missing data.`,
        );
      }
      if (!ok) missing.push(key);
    }

    const known = new Set(checkpoints.map((row) => row.snapshotKey).filter((key): key is string => Boolean(key)));
    const stored = await listKeys('snapshots/');
    const orphans = stored.filter((key) => !known.has(key));

    const snapshotBytes = checkpoints.reduce((sum, row) => sum + (row.snapshotBytes ?? 0), 0);
    const assetAgg = await prisma.projectAsset.aggregate({ _sum: { sizeBytes: true } });
    const storageBytes = snapshotBytes + (assetAgg._sum.sizeBytes ?? 0);

    await prisma.workspace.upsert({
      where: { id: WORKSPACE_ROW_ID },
      create: { id: WORKSPACE_ROW_ID, storageBytes },
      update: { storageBytes },
    });

    const detail = JSON.stringify({
      checked: checkpoints.length,
      missing,
      orphans,
      storageBytes,
    });
    await finishBackupRun({
      id: run.id,
      status: missing.length > 0 ? 'failed' : 'success',
      detail,
      startedAt: run.startedAt,
    });
    return {
      ok: missing.length === 0,
      missing,
      orphans,
      storageBytes,
      runId: run.id,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Storage verify failed';
    await finishBackupRun({
      id: run.id,
      status: 'failed',
      detail: message,
      startedAt: run.startedAt,
    }).catch((writeError) => {
      // /admin/backups reads BackupRun — a lost failure row looks like "still running".
      console.error('[backup] could not record the failed verify run', writeError);
    });
    return { ok: false, error: message, runId: run.id, missing: [] as string[], orphans: [] as string[] };
  }
}
