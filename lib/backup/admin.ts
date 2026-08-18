import { RECOVERY_SUMMARY, RESTORE_TEST_NOTICE, restoreCommand, STALE_BACKUP_BANNER } from './copy';
import { encryptionKeyFingerprint } from './fingerprint';
import { getBackupAlert } from './alerts';
import {
  latestRestoreTest,
  latestRunningDbBackup,
  latestSuccessfulDbBackup,
  listBackupRuns,
} from './runs';
import { isBackupStale, isRestoreTestOverdue } from './stale';

export async function getBackupAdmin() {
  const [lastSuccess, lastRestore, running, runs, alert] = await Promise.all([
    latestSuccessfulDbBackup(),
    latestRestoreTest(),
    latestRunningDbBackup(),
    listBackupRuns(40),
    getBackupAlert(),
  ]);

  const now = new Date();
  const lastSuccessAt = lastSuccess?.startedAt ?? null;
  const stale = isBackupStale(lastSuccessAt, now);
  const restoreOverdue = isRestoreTestOverdue(lastRestore?.startedAt ?? null, now);
  const key = process.env.ENCRYPTION_KEY || '';
  const latestKey = lastSuccess?.objectKey || 'backups/db/db-YYYY-MM-DD-xxxxxx.dump';

  return {
    lastSuccess: lastSuccess
      ? {
          id: lastSuccess.id,
          objectKey: lastSuccess.objectKey,
          sizeBytes: lastSuccess.sizeBytes,
          startedAt: lastSuccess.startedAt.toISOString(),
          ageMs: now.getTime() - lastSuccess.startedAt.getTime(),
        }
      : null,
    stale,
    staleBanner: stale ? STALE_BACKUP_BANNER : null,
    running: running
      ? { id: running.id, startedAt: running.startedAt.toISOString() }
      : null,
    runs: runs.map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      objectKey: row.objectKey,
      sizeBytes: row.sizeBytes,
      durationMs: row.durationMs,
      detail: row.detail,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    })),
    encryptionFingerprint: key ? encryptionKeyFingerprint(key) : null,
    restoreOverdue,
    restoreNotice: restoreOverdue ? RESTORE_TEST_NOTICE : null,
    restoreCommand: restoreCommand(latestKey),
    recoverySummary: RECOVERY_SUMMARY,
    alert,
  };
}
