export const STALE_BACKUP_BANNER = 'No backup in 2 days — check immediately';
export const BACK_UP_NOW_LABEL = 'Back up now';
export const RESTORE_TEST_NOTICE = 'Restore from backup has not been tested in over 90 days';
export const RECOVERY_SUMMARY =
  'To recover Navroop, provision a new server and set the original ENCRYPTION_KEY from your password manager (keep the key off the server). Restore the latest dump, point object storage at the same ElasticLake bucket, then redeploy. If the encryption key is lost, reconnect every integration and API key by hand.';

export function restoreCommand(objectKey: string) {
  return `npx tsx scripts/restore-db.ts --key ${objectKey}`;
}
