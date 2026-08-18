/**
 * Backup assertions, retention, restore guards, stale banner.
 * Run: npx tsx tests/backup.test.ts
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertDistinctBuckets,
  assertEncryptionKey,
  assertProductionBackupDriver,
  assertRestoreTarget,
  backupDriverFromEnv,
  isBackupStale,
  isRestoreTestOverdue,
  retentionDecisions,
} from '../lib/backup/index.ts';
import {
  downloadBackupObject,
  isMissingUploadHelper,
  uploadBackupFile,
} from '../lib/backup/client.ts';

let failed = 0;
let passed = 0;

function assert(cond: unknown, name: string) {
  if (cond) {
    passed += 1;
    console.log(`PASS  ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL  ${name}`);
}

function throws(fn: () => void, name: string) {
  try {
    fn();
    failed += 1;
    console.error(`FAIL  ${name} (did not throw)`);
  } catch {
    passed += 1;
    console.log(`PASS  ${name}`);
  }
}

function doesNotThrow(fn: () => void, name: string) {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${name}`, error);
  }
}

throws(
  () => assertDistinctBuckets('navroop-assets', 'navroop-assets'),
  'BACKUP_BUCKET === ELK_BUCKET fails assertion',
);
doesNotThrow(
  () => assertDistinctBuckets('navroop-assets', 'navroop-backups'),
  'distinct buckets pass',
);
doesNotThrow(
  () => assertDistinctBuckets(undefined, 'navroop-backups'),
  'missing app bucket skips distinct check',
);

throws(
  () => assertProductionBackupDriver('production', 'local'),
  'production + local driver refuses backup',
);
doesNotThrow(
  () => assertProductionBackupDriver('production', 's3'),
  'production + s3 driver allowed',
);
doesNotThrow(
  () => assertProductionBackupDriver('development', 'local'),
  'development + local driver allowed',
);

throws(
  () =>
    assertRestoreTarget(
      'postgresql://navroop:secret@postgres:5432/navroop',
      'postgresql://navroop:secret@postgres:5432/navroop',
    ),
  'restore refuses when URLs equal',
);
doesNotThrow(
  () =>
    assertRestoreTarget(
      'postgresql://navroop:secret@postgres:5432/navroop',
      'postgresql://navroop:secret@postgres:5432/navroop_restore',
    ),
  'restore allowed when database names differ',
);

const now = new Date('2026-08-17T12:00:00.000Z');
const objects = [
  { key: 'backups/db/db-2026-08-17-aaaa.dump', lastModified: new Date('2026-08-17T02:00:00.000Z') },
  { key: 'backups/db/db-2026-08-10-bbbb.dump', lastModified: new Date('2026-08-10T02:00:00.000Z') },
  { key: 'backups/db/db-2026-08-03-cccc.dump', lastModified: new Date('2026-08-03T02:00:00.000Z') },
  { key: 'backups/db/db-2026-07-01-dddd.dump', lastModified: new Date('2026-07-01T02:00:00.000Z') },
  { key: 'backups/db/db-2025-06-01-eeee.dump', lastModified: new Date('2025-06-01T02:00:00.000Z') },
];
const decisions = retentionDecisions(objects, now);
assert(decisions.keep.includes('backups/db/db-2026-08-17-aaaa.dump'), 'retention keeps daily within 14d');
assert(decisions.keep.includes('backups/db/db-2026-08-10-bbbb.dump'), 'retention keeps weekly within 8w');
assert(decisions.keep.includes('backups/db/db-2026-07-01-dddd.dump'), 'retention keeps monthly within 12m');
assert(decisions.delete.includes('backups/db/db-2025-06-01-eeee.dump'), 'retention deletes older than 12m');
assert(!decisions.delete.includes('backups/db/db-2026-08-17-aaaa.dump'), 'daily is not deleted');

assert(
  isBackupStale(new Date('2026-08-15T11:59:00.000Z'), now) === true,
  'stale >48h banner condition true',
);
assert(
  isBackupStale(new Date('2026-08-16T12:00:00.000Z'), now) === false,
  'fresh backup within 48h is not stale',
);
assert(isBackupStale(null, now) === true, 'no successful backup is stale');

assert(
  isRestoreTestOverdue(new Date('2026-05-18T12:00:00.000Z'), now) === true,
  'restore_test older than 90 days is overdue',
);
assert(
  isRestoreTestOverdue(new Date('2026-06-01T12:00:00.000Z'), now) === false,
  'restore_test within 90 days is current',
);
assert(isRestoreTestOverdue(null, now) === true, 'never-tested restore is overdue');

// --- Upload fallback is only for a missing package, never a retry ---
assert(
  isMissingUploadHelper(new Error("Cannot find module '@aws-sdk/lib-storage'")) === true,
  'a missing lib-storage package takes the single-PUT fallback',
);
assert(
  isMissingUploadHelper(new Error('ERR_MODULE_NOT_FOUND')) === true,
  'ERR_MODULE_NOT_FOUND takes the single-PUT fallback',
);
assert(
  isMissingUploadHelper(new Error('NetworkingError: socket hang up')) === false,
  'a failed upload is not retried, so a partly-read body is never re-sent',
);
assert(
  isMissingUploadHelper(new Error('Access Denied')) === false,
  'a rejected upload is not retried on the same body',
);
assert(isMissingUploadHelper('not an error') === false, 'a non-Error rejection is not a missing package');

// --- Local-driver upload/download round trip and the size guard ---
const backupEnvBefore = {
  endpoint: process.env.BACKUP_ENDPOINT,
  bucket: process.env.BACKUP_BUCKET,
  localDir: process.env.BACKUP_LOCAL_DIR,
};
const backupTmp = await mkdtemp(join(tmpdir(), 'navroop-backup-test-'));
// Force the local driver so this test can never reach a real backup bucket.
delete process.env.BACKUP_ENDPOINT;
delete process.env.BACKUP_BUCKET;
process.env.BACKUP_LOCAL_DIR = join(backupTmp, 'store');

try {
  assert(backupDriverFromEnv() === 'local', 'test env resolves to the local backup driver');

  const dumpBody = Buffer.from('navroop-dump-'.repeat(4096), 'utf8');
  const dumpPath = join(backupTmp, 'db.dump');
  await writeFile(dumpPath, dumpBody);

  const uploaded = await uploadBackupFile(dumpPath, 'backups/db/db-test.dump', dumpBody.length);
  assert(uploaded === dumpBody.length, 'upload reports the full byte count');
  const stored = await readFile(join(backupTmp, 'store', 'backups/db/db-test.dump'));
  assert(stored.equals(dumpBody), 'the stored backup is byte-identical to the dump');

  let mismatchMessage = '';
  try {
    await uploadBackupFile(dumpPath, 'backups/db/db-truncated.dump', dumpBody.length + 1);
  } catch (error) {
    mismatchMessage = error instanceof Error ? error.message : '';
  }
  assert(
    mismatchMessage.includes('size mismatch'),
    'an upload whose size does not match the dump is rejected, so a truncated backup cannot pass',
  );

  const restoredPath = join(backupTmp, 'restored.dump');
  await downloadBackupObject('backups/db/db-test.dump', restoredPath);
  const restored = await readFile(restoredPath);
  assert(restored.equals(dumpBody), 'download writes the backup back byte-identically');
} finally {
  if (backupEnvBefore.endpoint === undefined) delete process.env.BACKUP_ENDPOINT;
  else process.env.BACKUP_ENDPOINT = backupEnvBefore.endpoint;
  if (backupEnvBefore.bucket === undefined) delete process.env.BACKUP_BUCKET;
  else process.env.BACKUP_BUCKET = backupEnvBefore.bucket;
  if (backupEnvBefore.localDir === undefined) delete process.env.BACKUP_LOCAL_DIR;
  else process.env.BACKUP_LOCAL_DIR = backupEnvBefore.localDir;
  await rm(backupTmp, { recursive: true, force: true });
}

throws(() => assertEncryptionKey(''), 'ENCRYPTION_KEY empty fails');
throws(() => assertEncryptionKey('short-key-not-32-bytes'), 'ENCRYPTION_KEY too short fails');
doesNotThrow(
  () => assertEncryptionKey('a'.repeat(32)),
  'ENCRYPTION_KEY of 32 bytes passes',
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
