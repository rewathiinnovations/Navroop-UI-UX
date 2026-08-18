export const STALE_BACKUP_MS = 48 * 60 * 60 * 1000;
export const RESTORE_TEST_STALE_MS = 90 * 24 * 60 * 60 * 1000;

export function isBackupStale(lastSuccessAt: Date | null, now = new Date()) {
  if (!lastSuccessAt) return true;
  return now.getTime() - lastSuccessAt.getTime() > STALE_BACKUP_MS;
}

export function isRestoreTestOverdue(lastRestoreTestAt: Date | null, now = new Date()) {
  if (!lastRestoreTestAt) return true;
  return now.getTime() - lastRestoreTestAt.getTime() > RESTORE_TEST_STALE_MS;
}
