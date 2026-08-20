/**
 * Dump Postgres (custom, compress=9) and stream to the backup bucket.
 *   node ./node_modules/tsx/dist/cli.mjs scripts/backup-db.ts
 *
 * Ideally backup creds are write+list only; put a lifecycle policy on the bucket.
 * This script still applies dailies 14d / weeklies 8w / monthlies 12m.
 */
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { runDbBackup } from '../lib/backup/db.ts';

config({ path: resolve(process.cwd(), '.env') });
config({ path: resolve(process.cwd(), '.env.local'), override: true });

const result = await runDbBackup();
if ('objectKey' in result) {
  console.log(`Backup stored ${result.objectKey} (${result.sizeBytes} bytes)`);
}
if (!result.ok) {
  // `ok: false` now covers two very different endings: no backup at all, and a durable backup
  // whose retention pass failed — the dump is safe in the bucket, the expired ones were not
  // deleted. The second carries `detail` and no `error`, so printing `result.error` alone told
  // the operator "undefined" and exited 1 on a run that had actually stored their backup.
  console.error('detail' in result ? result.detail : result.error);
  process.exit(1);
}
