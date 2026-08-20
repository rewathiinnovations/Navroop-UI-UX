/**
 * GOVERNING RULE
 * A container filesystem is replaced on every deploy. A mounted volume survives
 * but is NOT backed up by DB backup and NOT replicated.
 *
 * Anything written to the volume must be reconstructible from Postgres or object storage.
 *
 * Dumps land in /data/tmp only until they are uploaded to the backup bucket, then deleted.
 * The backup object in the BACKUP_* bucket is the durable copy — never the volume.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { assertFreeSpaceForLargeOp, withTmpDir } from '../runtime/data-dir';
import { assertDistinctBuckets, assertProductionBackupDriver, backupDriver } from './assert';
import { clearBackupAlert, notifyBackupAlert, notifyStaleBackupIfNeeded } from './alerts';
import {
  backupObjectPrefix,
  deleteBackupObject,
  listBackupObjects,
  uploadBackupFile,
} from './client';
import { retentionDecisions } from './retention';
import { finishBackupRun, latestSuccessfulDbBackup, startBackupRun } from './runs';
import { isBackupStale } from './stale';

// The 90-day restore-test advisory is not raised from here. `runDbBackup` used to call
// `notifyBackupAlert('restore_test', …)` on every successful run, and because a `restore_test`
// BackupRun only exists after someone runs `scripts/restore-db.ts` against a separate
// RESTORE_DATABASE_URL — which a normal deploy does not set — `isRestoreTestOverdue(null)` was
// permanently true. Every nightly backup therefore raised a red banner immediately after
// clearing the previous one and emailed every admin a backup-failure-styled mail, forever,
// with nothing an operator could do in the product to stop it. It is an advisory, and
// `getBackupAdmin` already carries it as `restoreOverdue`/`restoreNotice` on /admin/backups.

// Ideally backup creds are write+list only; put a lifecycle policy on the bucket.
// Script retention still runs so dailies/weeklies/monthlies are enforced even without lifecycle.

function isoDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function dumpFilename(now = new Date()) {
  return `db-${isoDate(now)}-${randomBytes(3).toString('hex')}.dump`;
}

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
    });
  });
}

export async function runDbBackup() {
  await assertProductionBackupDriver();
  await assertDistinctBuckets();
  try {
    assertFreeSpaceForLargeOp();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Backup failed';
    return { ok: false as const, error: message };
  }

  const run = await startBackupRun('db');
  const filename = dumpFilename();
  const objectKey = `${backupObjectPrefix()}${filename}`;

  let sizeBytes: number;
  try {
    sizeBytes = await withTmpDir(async (tempDir) => {
      const localPath = join(tempDir, filename);
      const databaseUrl = process.env.DATABASE_URL?.trim();
      if (!databaseUrl) throw new Error('DATABASE_URL is required');

      await runCommand(
        'pg_dump',
        ['--format=custom', '--compress=9', '--file', localPath, databaseUrl],
        process.env,
      );
      const info = await stat(localPath);
      await uploadBackupFile(localPath, objectKey, info.size);
      return info.size;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Backup failed';
    await finishBackupRun({
      id: run.id,
      status: 'failed',
      objectKey,
      detail: message,
      startedAt: run.startedAt,
    }).catch((writeError) => {
      // /admin/backups reads BackupRun — a lost failure row looks like "still running".
      console.error('[backup] could not record the failed run', writeError);
    });
    await notifyBackupAlert('failed', message);
    return { ok: false as const, error: message, runId: run.id };
  }

  // The receipt is written the moment the object is durable and its size is HeadObject-proven.
  // It used to be written *after* retention, inside the same try: one 403 or timeout while
  // deleting an already-expired object threw to the catch above, stored this run `failed`,
  // emailed every admin, and left `latestSuccessfulDbBackup()` on yesterday's run — so within
  // 48 hours the stale-backup alert fired too and the operator was told they had no backup
  // while a good one sat in the bucket. Retention is housekeeping and may not invalidate it.
  await finishBackupRun({
    id: run.id,
    status: 'success',
    objectKey,
    sizeBytes,
    startedAt: run.startedAt,
  });

  let retentionError: string | null = null;
  try {
    const objects = await listBackupObjects();
    // The run's own dump is protected by key: if the bucket lists it with a wrong
    // LastModified, no cutoff and no floor ordering may hand it to the delete loop below.
    const decisions = retentionDecisions(objects, new Date(), { protectedKeys: [objectKey] });
    for (const key of decisions.delete) {
      await deleteBackupObject(key);
    }
  } catch (error) {
    retentionError = error instanceof Error ? error.message : String(error);
    console.error('[backup] retention pass failed; expired objects are still in the bucket', {
      error: retentionError,
    });
    // The backup stays `success` — it is durable — but the run still owes the operator this,
    // because nothing else in the product notices a bucket that has stopped shedding
    // expired dumps. It rides on the BackupRun detail and on `ok` below.
    await finishBackupRun({
      id: run.id,
      status: 'success',
      objectKey,
      sizeBytes,
      detail: `retention pass failed: ${retentionError}`,
      startedAt: run.startedAt,
    }).catch((writeError) => {
      console.error('[backup] could not record the retention failure', writeError);
    });
  }

  const last = await latestSuccessfulDbBackup();
  if (isBackupStale(last?.startedAt ?? null)) await notifyStaleBackupIfNeeded(true);
  else await clearBackupAlert();

  return {
    // A failed retention pass is not a lost backup, so no admin mail and no `failed` BackupRun
    // — but it is unbounded bucket growth only an operator can clear, so the cron run says so.
    ok: retentionError === null,
    detail: retentionError
      ? `backup stored ${objectKey} (${sizeBytes} bytes), but the retention pass failed: ${retentionError}`
      : null,
    objectKey,
    sizeBytes,
    retentionError,
    runId: run.id,
  };
}

export function describeBackupDriver() {
  return backupDriver();
}
