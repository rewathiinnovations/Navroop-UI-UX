import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * /admin/backups reads BackupRun, so a lost failure row looks like "still running" forever.
 * `lib/backup/verify.ts` already logged that; restore swallowed it with
 * `.catch(() => undefined)`, which is the difference between an operator seeing a failed
 * restore test and an operator seeing a restore that never came back.
 */

const finishBackupRun = vi.fn();
const downloadBackupObject = vi.fn();

vi.mock('@/lib/backup/assert', () => ({ assertRestoreTarget: () => undefined }));
vi.mock('@/lib/runtime/data-dir', () => ({
  assertFreeSpaceForLargeOp: () => undefined,
  withTmpDir: async <T>(fn: (dir: string) => Promise<T>) => fn('/tmp/restore-probe'),
}));
vi.mock('@/lib/backup/client', () => ({
  downloadBackupObject: (...args: unknown[]) => downloadBackupObject(...args),
  listBackupObjects: async () => [],
}));
vi.mock('@/lib/backup/runs', () => ({
  startBackupRun: async () => ({ id: 'run_1', startedAt: new Date() }),
  finishBackupRun: (...args: unknown[]) => finishBackupRun(...args),
}));

let lines: string[];

beforeEach(() => {
  finishBackupRun.mockReset();
  downloadBackupObject.mockReset();
  downloadBackupObject.mockRejectedValue(new Error('object is missing from the bucket'));
  lines = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
  });
  process.env.RESTORE_DATABASE_URL = 'postgresql://localhost:5433/restore_probe';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('restoreDbBackup failure bookkeeping', () => {
  it('marks the run failed when the restore fails', async () => {
    finishBackupRun.mockResolvedValue({});
    const { restoreDbBackup } = await import('@/lib/backup/restore');

    const result = await restoreDbBackup('backups/db-1.dump');

    expect(result.ok).toBe(false);
    expect(finishBackupRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    expect(lines.join(' ')).not.toContain('could not record the failed restore run');
  });

  it('logs when the failure row itself cannot be written', async () => {
    finishBackupRun.mockRejectedValue(new Error('database is unreachable'));
    const { restoreDbBackup } = await import('@/lib/backup/restore');

    const result = await restoreDbBackup('backups/db-1.dump');

    // Still returns the original failure — the run row is bookkeeping, not the outcome.
    expect(result.ok).toBe(false);
    expect(lines.join(' ')).toContain('could not record the failed restore run');
    expect(lines.join(' ')).toContain('database is unreachable');
  });
});
