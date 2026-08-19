/**
 * List backup dumps, or restore one into RESTORE_DATABASE_URL (must differ from DATABASE_URL).
 *   npx tsx scripts/restore-db.ts
 *   npx tsx scripts/restore-db.ts --key backups/db/db-YYYY-MM-DD-xxxxxx.dump
 */
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { listDbBackups, restoreDbBackup } from '../lib/backup/restore.ts';

config({ path: resolve(process.cwd(), '.env') });
config({ path: resolve(process.cwd(), '.env.local'), override: true });

function argValue(flag: string) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] || null;
}

const key = argValue('--key');
if (!key) {
  const rows = await listDbBackups();
  if (rows.length === 0) {
    console.log('No backups found.');
    process.exit(0);
  }
  for (const row of rows) {
    console.log(`${row.lastModified}  ${row.sizeBytes}  ${row.key}`);
  }
  process.exit(0);
}

// `restoreDbBackup` calls `assertRestoreTarget` before it touches anything, so an unset or
// production-pointing RESTORE_DATABASE_URL throws out here rather than returning `ok: false`.
// Catching it keeps the refusal readable: an operator aiming a restore at the wrong database
// should see the rule, not a stack trace.
const result = await restoreDbBackup(key).catch((error: unknown) => ({
  ok: false as const,
  error: error instanceof Error ? error.message : String(error),
  counts: {} as Record<string, number>,
}));
if (!result.ok) {
  console.error(result.error);
  process.exit(1);
}
console.log('Restore finished. Row counts:');
for (const [table, count] of Object.entries(result.counts)) {
  console.log(`  ${table}: ${count}`);
}
