import { prisma } from '@/lib/db';
import { exists, get, listKeys } from '@/lib/storage';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { finishBackupRun, startBackupRun } from './runs';

export async function runStorageVerify() {
  const run = await startBackupRun('storage_verify');
  try {
    const checkpoints = await prisma.checkpoint.findMany({
      where: { snapshotKey: { not: null }, snapshotPruned: false },
      orderBy: { createdAt: 'desc' },
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

    // HeadObject only proves an entry exists in the bucket index. It answers 200 for an object
    // whose bytes cannot be fetched: a credential that grants HeadObject but not GetObject, an
    // object transitioned to an archive class, or a zero-length object left behind by a failed
    // upload. This job exists to answer "would a restore work", so once per run it actually
    // reads one snapshot — the newest, because that is the one a restore reaches for first.
    // It proves the bucket serves bytes; it does not validate snapshot contents.
    const unreadable: string[] = [];
    const probeKey = checkpoints[0]?.snapshotKey ?? null;
    if (probeKey && !missing.includes(probeKey)) {
      let body: Buffer | null;
      try {
        body = await get(probeKey);
      } catch (error) {
        // Same rule as the HEAD above: a refused read is a storage failure, and presenting it
        // as data loss on /admin/backups invites a restore as the response to a credentials
        // problem.
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Could not read snapshot storage (${probeKey}): ${detail}. This is a storage failure, not missing data.`,
        );
      }
      if (!body || body.length === 0) unreadable.push(probeKey);
    }

    const known = new Set(
      checkpoints.map((row) => row.snapshotKey).filter((key): key is string => Boolean(key)),
    );
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

    const ok = missing.length === 0 && unreadable.length === 0;
    const detail = JSON.stringify({
      checked: checkpoints.length,
      missing,
      unreadable,
      readProbe: probeKey,
      orphans,
      storageBytes,
    });
    await finishBackupRun({
      id: run.id,
      status: ok ? 'success' : 'failed',
      detail,
      startedAt: run.startedAt,
    });
    return {
      ok,
      detail: ok
        ? null
        : `${missing.length} of ${checkpoints.length} snapshots are missing and ${unreadable.length} could not be read`,
      missing,
      unreadable,
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
    return {
      ok: false,
      detail: message,
      error: message,
      runId: run.id,
      missing: [] as string[],
      unreadable: [] as string[],
      orphans: [] as string[],
    };
  }
}
