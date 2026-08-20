import { positiveNumberSetting } from '@/lib/settings/numbers';

/**
 * Defaults, not the only answer: both windows are operator knobs on /admin/config
 * (`backups.staleAfterHours`, `backups.restoreTestDays`) resolved by the two functions
 * below (F-793). The constants stay exported because the pure predicates have to remain
 * synchronous — `getBackupAdmin` and `runDbBackup` are the async callers that resolve.
 */
export const STALE_BACKUP_MS = 48 * 60 * 60 * 1000;
export const RESTORE_TEST_STALE_MS = 90 * 24 * 60 * 60 * 1000;

export async function staleBackupMs() {
  return (await positiveNumberSetting('backups.staleAfterHours', 48)) * 60 * 60 * 1000;
}

export async function restoreTestStaleMs() {
  return (await positiveNumberSetting('backups.restoreTestDays', 90)) * 24 * 60 * 60 * 1000;
}

export function isBackupStale(
  lastSuccessAt: Date | null,
  now = new Date(),
  thresholdMs = STALE_BACKUP_MS,
) {
  if (!lastSuccessAt) return true;
  return now.getTime() - lastSuccessAt.getTime() > thresholdMs;
}

export function isRestoreTestOverdue(
  lastRestoreTestAt: Date | null,
  now = new Date(),
  thresholdMs = RESTORE_TEST_STALE_MS,
) {
  if (!lastRestoreTestAt) return true;
  return now.getTime() - lastRestoreTestAt.getTime() > thresholdMs;
}
