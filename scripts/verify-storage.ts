/**
 * HeadObject each Checkpoint.snapshotKey, read the newest one back to prove the bucket serves
 * bytes, report missing/unreadable/orphan objects, reconcile Workspace.storageBytes.
 *   npx tsx scripts/verify-storage.ts
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
  `Checked snapshots. missing=${result.missing.length} unreadable=${result.unreadable.length} orphans=${result.orphans.length}`,
);
if (result.missing.length) {
  console.log('Missing:');
  for (const key of result.missing) console.log(`  ${key}`);
}
if (result.unreadable.length) {
  console.log('Unreadable (present, but the bytes could not be fetched):');
  for (const key of result.unreadable) console.log(`  ${key}`);
}
if (result.orphans.length) {
  console.log('Orphans:');
  for (const key of result.orphans) console.log(`  ${key}`);
}
if (result.storageBytes != null) {
  console.log(`Workspace.storageBytes reconciled to ${result.storageBytes}`);
}
if (!result.ok) process.exit(1);
