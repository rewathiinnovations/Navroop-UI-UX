/**
 * GOVERNING RULE
 * A container filesystem is replaced on every deploy. A mounted volume survives
 * but is NOT backed up by DB backup and NOT replicated.
 *
 * Anything written to the volume must be reconstructible from Postgres or object storage.
 *
 * Restore downloads land in /data/tmp only until pg_restore finishes, then they are deleted.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { assertFreeSpaceForLargeOp, withTmpDir } from '../runtime/data-dir';
import { assertRestoreTarget } from './assert';
import { downloadBackupObject, listBackupObjects } from './client';
import { finishBackupRun, startBackupRun } from './runs';

const COUNT_TABLES = [
  'User',
  'Project',
  'Checkpoint',
  'Workspace',
  'Integration',
  'Deployment',
  'CustomDomain',
  'ProjectAsset',
  'BackupRun',
] as const;

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

function countTable(restoreUrl: string, table: string) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(
      'psql',
      [restoreUrl, '-At', '-c', `SELECT COUNT(*) FROM "${table}"`],
      { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`psql ${table} exited ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
        return;
      }
      resolve(Number(stdout.trim() || 0));
    });
  });
}

export async function listDbBackups() {
  const objects = await listBackupObjects();
  return objects
    .slice()
    .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime())
    .map((object) => ({
      key: object.key,
      sizeBytes: object.sizeBytes,
      lastModified: object.lastModified.toISOString(),
    }));
}

export async function restoreDbBackup(objectKey: string) {
  assertRestoreTarget();
  assertFreeSpaceForLargeOp();
  const run = await startBackupRun('restore_test');

  try {
    return await withTmpDir(async (tempDir) => {
      const localPath = join(tempDir, objectKey.split('/').pop() || 'restore.dump');
      const restoreUrl = process.env.RESTORE_DATABASE_URL!.trim();
      await downloadBackupObject(objectKey, localPath);
      await runCommand('pg_restore', ['--no-owner', '--no-acl', `--dbname=${restoreUrl}`, localPath], process.env);

      const counts: Record<string, number> = {};
      for (const table of COUNT_TABLES) {
        counts[table] = await countTable(restoreUrl, table);
      }

      await finishBackupRun({
        id: run.id,
        status: 'success',
        objectKey,
        detail: JSON.stringify(counts),
        startedAt: run.startedAt,
      });
      return { ok: true as const, objectKey, counts, runId: run.id };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Restore failed';
    await finishBackupRun({
      id: run.id,
      status: 'failed',
      objectKey,
      detail: message,
      startedAt: run.startedAt,
    }).catch((writeError) => {
      // /admin/backups reads BackupRun — a lost failure row looks like "still running".
      console.error('[backup] could not record the failed restore run', writeError);
    });
    return { ok: false as const, error: message, runId: run.id };
  }
}
