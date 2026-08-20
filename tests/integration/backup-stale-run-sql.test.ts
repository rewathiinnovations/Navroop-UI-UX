import '../setup/env';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { testPrismaClient } from '../setup/db';
import { failStaleRunningBackupRuns } from '@/lib/backup/runs';

/**
 * Settling abandoned `BackupRun` rows, on real Postgres (F-722).
 *
 * A backup killed mid-`pg_dump` — redeploy, OOM — leaves `running` forever: the only writers
 * of a terminal status are the success and failure paths inside the process that opened the
 * row. `/admin/backups` then shows a backup in progress indefinitely and "Back up now" stays
 * disabled, with nothing in the product able to clear it.
 *
 * The whole fix is one UPDATE with three predicates and a computed duration, so a unit test
 * over a mocked Prisma would assert the mock. These cases run the statement: each predicate is
 * load-bearing and fails differently — a missing `status` filter would rewrite finished runs,
 * a missing `startedAt` bound would fail the backup that is running right now, and a missing
 * `kind` filter would settle storage-verify and restore-test rows the caller knows nothing
 * about.
 */

const prisma = testPrismaClient();

const IDS = {
  abandoned: 'bck_stale_probe_abandoned',
  fresh: 'bck_stale_probe_fresh',
  finished: 'bck_stale_probe_finished',
  otherKind: 'bck_stale_probe_other_kind',
} as const;

const NOW = Date.now();
const THREE_HOURS_AGO = new Date(NOW - 3 * 60 * 60 * 1000);
const CUTOFF = new Date(NOW - 60 * 60 * 1000);
const DETAIL = 'The process running this backup did not finish and recorded no result.';

async function seedRun(id: string, kind: string, status: string, startedAt: Date) {
  await prisma.$executeRaw`
    INSERT INTO "BackupRun" ("id", "kind", "status", "startedAt")
    VALUES (${id}, ${kind}, ${status}, ${startedAt})
  `;
}

async function readRun(id: string) {
  const rows = await prisma.$queryRaw<
    { status: string; detail: string | null; durationMs: number | null; finishedAt: Date | null }[]
  >`
    SELECT "status", "detail", "durationMs", "finishedAt" FROM "BackupRun" WHERE "id" = ${id}
  `;
  return rows[0];
}

beforeEach(async () => {
  await prisma.$executeRaw`DELETE FROM "BackupRun" WHERE "id" LIKE 'bck_stale_probe_%'`;
  await seedRun(IDS.abandoned, 'db', 'running', THREE_HOURS_AGO);
  await seedRun(IDS.fresh, 'db', 'running', new Date(NOW - 60_000));
  await seedRun(IDS.finished, 'db', 'success', THREE_HOURS_AGO);
  await seedRun(IDS.otherKind, 'restore_test', 'running', THREE_HOURS_AGO);
});

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM "BackupRun" WHERE "id" LIKE 'bck_stale_probe_%'`;
  await prisma.$disconnect();
});

describe('failStaleRunningBackupRuns', () => {
  it('fails the abandoned run with a real duration and the reason an operator can read', async () => {
    const settled = await failStaleRunningBackupRuns({
      kind: 'db',
      startedBefore: CUTOFF,
      detail: DETAIL,
    });

    expect(settled).toBe(1);
    const row = await readRun(IDS.abandoned);
    expect(row.status).toBe('failed');
    expect(row.detail).toBe(DETAIL);
    expect(row.finishedAt).toBeInstanceOf(Date);
    // Measured from the row's own start, not from zero: a three-hour dump reads as three hours.
    expect(row.durationMs).toBeGreaterThan(2 * 60 * 60 * 1000);
  });

  it('leaves the backup that is running right now alone', async () => {
    await failStaleRunningBackupRuns({ kind: 'db', startedBefore: CUTOFF, detail: DETAIL });
    const row = await readRun(IDS.fresh);
    expect(row.status).toBe('running');
    expect(row.finishedAt).toBeNull();
  });

  it('never rewrites a run that already finished, or a run of another kind', async () => {
    await failStaleRunningBackupRuns({ kind: 'db', startedBefore: CUTOFF, detail: DETAIL });
    expect((await readRun(IDS.finished)).status).toBe('success');
    expect((await readRun(IDS.otherKind)).status).toBe('running');
  });

  it('reports zero when there is nothing to settle, so the caller stays quiet', async () => {
    await failStaleRunningBackupRuns({ kind: 'db', startedBefore: CUTOFF, detail: DETAIL });
    const again = await failStaleRunningBackupRuns({
      kind: 'db',
      startedBefore: CUTOFF,
      detail: DETAIL,
    });
    expect(again).toBe(0);
  });
});
