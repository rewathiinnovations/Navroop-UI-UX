export const STALE_BACKUP_BANNER = 'No backup in 2 days — check immediately';
export const BACK_UP_NOW_LABEL = 'Back up now';
export const RESTORE_TEST_NOTICE = 'Restore from backup has not been tested in over 90 days';
export const RECOVERY_SUMMARY =
  'To recover Navroop, provision a new server and set the original ENCRYPTION_KEY from your password manager (keep the key off the server). Restore the latest dump, point object storage at the same ElasticLake bucket, then redeploy. If the encryption key is lost, reconnect every integration and API key by hand.';

/**
 * The one form an operator is ever shown (F-644).
 *
 * Not `pnpm exec` and not `npx`: pnpm runs a dependency-status check before `exec` and can
 * offer to purge `node_modules` first, and `npx` has corrupted `pnpm-workspace.yaml` here.
 * Both hooks and `verify` invoke the installed binary directly, and a disaster recovery is
 * the worst possible moment to lose the dependency tree the command runs from.
 */
export function restoreCommand(objectKey: string) {
  return `node ./node_modules/tsx/dist/cli.mjs scripts/restore-db.ts --key ${objectKey}`;
}
