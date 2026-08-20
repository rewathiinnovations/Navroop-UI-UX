import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cronClaimStaleMs, DB_BACKUP_CLAIM } from '@/lib/cron/claim';

/**
 * What `/admin/backups` may call "running" (F-722).
 *
 * `latestRunningDbBackup()` returns the newest `db` row whose status is still `running`, and
 * "Back up now" is disabled whenever that is non-null. Nothing ever settled a row left behind
 * by a killed process, so one OOM during a dump disabled the only control an operator has —
 * permanently, and with the screen insisting a backup was in progress the whole time.
 *
 * The row is not hidden: it stays in the run list, where it reads as what it is. It just stops
 * counting as work in flight once it is past the budget the claim gives a live dump, which is
 * the same window `runDbBackup` uses to settle it on the next attempt.
 */

const runs = vi.hoisted(() => ({
  latestRestoreTest: vi.fn(),
  latestRunningDbBackup: vi.fn(),
  latestSuccessfulDbBackup: vi.fn(),
  listBackupRuns: vi.fn(),
}));

vi.mock('@/lib/backup/runs', () => runs);
vi.mock('@/lib/backup/alerts', () => ({ getBackupAlert: async () => null }));

const { getBackupAdmin } = await import('@/lib/backup/admin');

const BUDGET_MS = cronClaimStaleMs(DB_BACKUP_CLAIM);

function runningRow(startedAt: Date) {
  return {
    id: 'bck_running',
    kind: 'db' as const,
    status: 'running',
    objectKey: null,
    sizeBytes: null,
    durationMs: null,
    detail: null,
    startedAt,
    finishedAt: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  runs.latestRestoreTest.mockResolvedValue(null);
  runs.latestSuccessfulDbBackup.mockResolvedValue({
    id: 'bck_ok',
    kind: 'db',
    status: 'success',
    objectKey: 'backups/db/db-2026-08-20-abcdef.dump',
    sizeBytes: '10',
    durationMs: 1_000,
    detail: null,
    startedAt: new Date(),
    finishedAt: new Date(),
  });
  runs.latestRunningDbBackup.mockResolvedValue(null);
  runs.listBackupRuns.mockResolvedValue([]);
});

describe('getBackupAdmin', () => {
  it('reports a dump that is genuinely in flight', async () => {
    const startedAt = new Date(Date.now() - Math.floor(BUDGET_MS / 2));
    runs.latestRunningDbBackup.mockResolvedValue(runningRow(startedAt));

    const data = await getBackupAdmin();
    expect(data.running).toEqual({ id: 'bck_running', startedAt: startedAt.toISOString() });
  });

  it('stops calling a killed run "running", so the operator can start a new backup', async () => {
    const startedAt = new Date(Date.now() - BUDGET_MS - 60_000);
    const row = runningRow(startedAt);
    runs.latestRunningDbBackup.mockResolvedValue(row);
    runs.listBackupRuns.mockResolvedValue([row]);

    const data = await getBackupAdmin();
    expect(data.running).toBeNull();
    // Not hidden: the row is still on the page, still saying `running`, until the next
    // backup settles it as failed.
    expect(data.runs).toEqual([expect.objectContaining({ id: 'bck_running', status: 'running' })]);
  });
});
