/**
 * Dump Postgres (custom, compress=9) and stream to the backup bucket.
 *   npx tsx scripts/backup-db.ts
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
if (!result.ok) {
  console.error(result.error);
  process.exit(1);
}
console.log(`Backup stored ${result.objectKey} (${result.sizeBytes} bytes)`);
