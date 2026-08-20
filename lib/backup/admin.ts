import { cronClaimStaleMs, DB_BACKUP_CLAIM } from '../cron/claim';
import { RECOVERY_SUMMARY, RESTORE_TEST_NOTICE, restoreCommand, STALE_BACKUP_BANNER } from './copy';
import { encryptionKeyFingerprint } from './fingerprint';
import { getBackupAlert } from './alerts';
import {
  latestRestoreTest,
  latestRunningDbBackup,
  latestSuccessfulDbBackup,
  listBackupRuns,
} from './runs';
import { isBackupStale, isRestoreTestOverdue, restoreTestStaleMs, staleBackupMs } from './stale';

export async function getBackupAdmin() {
  const [lastSuccess, lastRestore, running, runs, alert, staleMs, restoreMs] = await Promise.all([
    latestSuccessfulDbBackup(),
    latestRestoreTest(),
    latestRunningDbBackup(),
    listBackupRuns(40),
    getBackupAlert(),
    staleBackupMs(),
    restoreTestStaleMs(),
  ]);

  const now = new Date();
  const lastSuccessAt = lastSuccess?.startedAt ?? null;
  const stale = isBackupStale(lastSuccessAt, now, staleMs);
  const restoreOverdue = isRestoreTestOverdue(lastRestore?.startedAt ?? null, now, restoreMs);
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
    // Only a run inside the claim's in-flight budget counts as work in progress. A process
    // killed mid-dump leaves its row `running` forever, and "Back up now" is disabled while
    // this is non-null — so the one control that would settle the row was the one the row
    // disabled (F-722). Past the budget it is history, not progress: the row stays in `runs`
    // exactly as recorded, and the next backup marks it failed.
    running:
      running && now.getTime() - running.startedAt.getTime() < cronClaimStaleMs(DB_BACKUP_CLAIM)
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
