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
import {
  assertDistinctBuckets,
  assertProductionBackupDriver,
  backupDriverFromEnv,
} from './assert';
import { clearBackupAlert, notifyBackupAlert, notifyStaleBackupIfNeeded } from './alerts';
import { backupObjectPrefix, deleteBackupObject, listBackupObjects, uploadBackupFile } from './client';
import { retentionDecisions } from './retention';
import { RESTORE_TEST_NOTICE } from './copy';
import { finishBackupRun, latestRestoreTest, latestSuccessfulDbBackup, startBackupRun } from './runs';
import { isBackupStale, isRestoreTestOverdue } from './stale';

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
  assertProductionBackupDriver();
  assertDistinctBuckets();
  try {
    assertFreeSpaceForLargeOp();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Backup failed';
    return { ok: false as const, error: message };
  }

  const run = await startBackupRun('db');
  const filename = dumpFilename();
  const objectKey = `${backupObjectPrefix()}${filename}`;

  try {
    return await withTmpDir(async (tempDir) => {
      const localPath = join(tempDir, filename);
      const databaseUrl = process.env.DATABASE_URL?.trim();
      if (!databaseUrl) throw new Error('DATABASE_URL is required');

      await runCommand('pg_dump', ['--format=custom', '--compress=9', '--file', localPath, databaseUrl], process.env);
      const info = await stat(localPath);
      await uploadBackupFile(localPath, objectKey, info.size);

      const objects = await listBackupObjects();
      const decisions = retentionDecisions(objects);
      for (const key of decisions.delete) {
        await deleteBackupObject(key);
      }

      await finishBackupRun({
        id: run.id,
        status: 'success',
        objectKey,
        sizeBytes: info.size,
        startedAt: run.startedAt,
      });

      const last = await latestSuccessfulDbBackup();
      const stale = isBackupStale(last?.startedAt ?? null);
      if (stale) await notifyStaleBackupIfNeeded(true);
      else await clearBackupAlert();
      const lastRestore = await latestRestoreTest();
      if (isRestoreTestOverdue(lastRestore?.startedAt ?? null)) {
        await notifyBackupAlert('restore_test', RESTORE_TEST_NOTICE);
      }

      return { ok: true as const, objectKey, sizeBytes: info.size, runId: run.id };
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
}

export function describeBackupDriver() {
  return backupDriverFromEnv();
}
