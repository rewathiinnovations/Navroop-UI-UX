/**
 * HeadObject one page of Checkpoint.snapshotKey (resuming where the previous run stopped),
 * read the newest snapshot back to prove the bucket serves bytes, diff every prefix this
 * product writes against the rows that reference it, and reconcile Workspace.storageBytes.
 *   node ./node_modules/tsx/dist/cli.mjs scripts/verify-storage.ts
 *
 * Enable versioning + lifecycle on ElasticLake buckets (app and backup).
 */
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { runStorageVerify } from '../lib/backup/verify.ts';

config({ path: resolve(process.cwd(), '.env') });
config({ path: resolve(process.cwd(), '.env.local'), override: true });

const result = await runStorageVerify();
if ('error' in result && result.error) {
  console.error(result.error);
  process.exit(1);
}
console.log(
  `Checked ${result.checked ?? 0} of ${result.totalSnapshots ?? 0} snapshots. missing=${result.missing.length} unreadable=${result.unreadable.length}`,
);
if (result.nextCursor) {
  console.log(`More snapshots remain; the next run resumes after checkpoint ${result.nextCursor}.`);
}
if (result.missing.length) {
  console.log('Missing:');
  for (const key of result.missing) console.log(`  ${key}`);
}
if (result.unreadable.length) {
  console.log('Unreadable (present, but the bytes could not be fetched):');
  for (const key of result.unreadable) console.log(`  ${key}`);
}
if (result.orphans) {
  const { totals, action, graceDays } = result.orphans;
  console.log(
    `Unreferenced objects: ${totals.orphans} (${totals.orphanBytes} bytes), ${totals.reclaimable} past the ${graceDays}-day grace period. Action: ${action}. Deleted ${totals.deleted}, failed ${totals.deleteFailed}.`,
  );
  for (const scope of result.orphans.scopes) {
    if (scope.orphans === 0) continue;
    console.log(`  ${scope.prefix} (${scope.label}): ${scope.orphans} of ${scope.scanned}`);
    for (const key of scope.sample) console.log(`    ${key}`);
    if (scope.orphans > scope.sample.length) {
      console.log(`    … and ${scope.orphans - scope.sample.length} more`);
    }
  }
}
for (const warning of result.warnings) console.log(`WARNING: ${warning}`);
if (result.storageBytes != null) {
  console.log(`Workspace.storageBytes reconciled to ${result.storageBytes}`);
}
if (!result.ok) process.exit(1);
