import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The daily maintenance cron carries six jobs, and one bad row may not take the other five.
 *
 * `deleteObject` throws on a stored key `normalizeKey` cannot resolve (it used to silently
 * rewrite), and an S3 delete surfaces credential and throttle errors. The delete was
 * unguarded and every downstream prune ran after the loop, so one poisoned `snapshotKey`
 * turned `POST /api/cron/thin-checkpoints` into a 500 that did no maintenance at all: no
 * thinning, no presence pruning, no audit-log pruning, no preview-build pruning. The same row
 * was re-selected on the next run, so it never self-healed, and because `thin-checkpoints` was
 * not in `CRON_STALE_MS` the digest never mentioned it — the operator found out when the
 * volume filled. `prunePreviewBuilds` and `purgeDeletedProjects` were both hardened against
 * exactly this; their caller was missed.
 *
 * Goes red if: one failing key aborts the loop or the prunes; a held-back checkpoint has its
 * `snapshotKey` cleared (that column is the only pointer to the bytes); or a run with blocked
 * snapshots reports itself healthy.
 */

const db = vi.hoisted(() => ({
  groupBy: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
}));
const storage = vi.hoisted(() => ({ deleteObject: vi.fn() }));
const usage = vi.hoisted(() => ({ adjustStorageBytes: vi.fn() }));
const prunes = vi.hoisted(() => ({
  presence: vi.fn(),
  audit: vi.fn(),
  preview: vi.fn(),
  observability: vi.fn(),
  settle: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    checkpoint: { groupBy: db.groupBy, findMany: db.findMany, update: db.update },
  },
}));
vi.mock('@/lib/storage', () => ({ deleteObject: storage.deleteObject }));
vi.mock('@/lib/storage/usage', () => ({ adjustStorageBytes: usage.adjustStorageBytes }));
vi.mock('@/lib/checkpoints/retention', async () => {
  // `isThinEligible` is the real rule — the point of these cases is the failure handling
  // around it, not a reimplementation of the retention policy.
  const actual = await vi.importActual<typeof import('@/lib/checkpoints/retention')>(
    '@/lib/checkpoints/retention',
  );
  return { ...actual, checkpointRetentionDays: async () => 7 };
});
vi.mock('@/lib/projects/presence', () => ({ pruneStalePresence: prunes.presence }));
vi.mock('@/lib/audit/log', () => ({ pruneAuditLogs: prunes.audit }));
vi.mock('@/lib/preview/prune', () => ({ prunePreviewBuilds: prunes.preview }));
vi.mock('@/lib/observability/prune', () => ({ pruneObservabilityHistory: prunes.observability }));
// The quality-signal settle pass moved here off the /admin/quality render, which
// must not write (F-732). It is a downstream job like the prunes above.
vi.mock('@/lib/signals/collect', () => ({ settleIdleProjects: prunes.settle }));

const { thinCheckpoints } = await import('@/lib/checkpoints/thin');

const OLD = new Date('2026-08-01T00:00:00.000Z');

function checkpoint(id: string, projectId: string, snapshotKey: string) {
  return {
    id,
    projectId,
    createdAt: OLD,
    isBookmarked: false,
    snapshotPruned: false,
    snapshotKey,
    snapshotBytes: 1_000,
  };
}

const ROWS = [
  checkpoint('cp_poison', 'proj_a', '/absolute/key/refused-by-normalize'),
  checkpoint('cp_good', 'proj_b', 'snapshots/proj_b/cp_good.zip'),
];

beforeEach(() => {
  vi.clearAllMocks();
  db.groupBy.mockResolvedValue([
    // A newer checkpoint exists for each project, so neither candidate is the project's latest
    // and both are genuinely eligible for thinning.
    { projectId: 'proj_a', _max: { createdAt: new Date('2026-08-18T00:00:00.000Z') } },
    { projectId: 'proj_b', _max: { createdAt: new Date('2026-08-18T00:00:00.000Z') } },
  ]);
  db.findMany.mockResolvedValue(ROWS);
  db.update.mockResolvedValue({});
  storage.deleteObject.mockResolvedValue(undefined);
  usage.adjustStorageBytes.mockResolvedValue(undefined);
  prunes.presence.mockResolvedValue({ pruned: 3 });
  prunes.audit.mockResolvedValue({ deleted: 4 });
  prunes.preview.mockResolvedValue({ deleted: 5, reclaimedBytes: 500 });
  prunes.observability.mockResolvedValue({ cronRuns: 6, checks: 7, cutoff: null });
  prunes.settle.mockResolvedValue(8);
});

describe('thinCheckpoints when one snapshot key cannot be deleted', () => {
  it('thins the rest and still runs every downstream prune', async () => {
    storage.deleteObject.mockImplementation(async (key: string) => {
      if (key.startsWith('/')) throw new Error(`StorageKeyError: ${key} is an absolute path`);
    });

    const result = await thinCheckpoints();

    expect(result.thinned).toBe(1);
    expect(result.blocked).toBe(1);
    expect(result.reclaimedBytes).toBe(1_000);
    // The five jobs that used to be skipped entirely, plus the settle pass.
    expect(result.presencePruned).toBe(3);
    expect(result.auditPruned).toBe(4);
    expect(result.previewDeleted).toBe(5);
    expect(result.cronRunsPruned).toBe(6);
    expect(result.observabilityChecksPruned).toBe(7);
    expect(result.projectsSettled).toBe(8);
  });

  it('does not read as a healthy run, and names the cost', async () => {
    storage.deleteObject.mockRejectedValueOnce(new Error('StorageKeyError: absolute path'));

    const result = await thinCheckpoints();

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('could not be thinned');
  });

  it('keeps the blocked checkpoint pointing at its bytes so the next run retries', async () => {
    storage.deleteObject.mockImplementation(async (key: string) => {
      if (key.startsWith('/')) throw new Error('StorageKeyError');
    });

    await thinCheckpoints();

    // Only the checkpoint whose object is actually gone is marked pruned. Clearing
    // `snapshotKey` on the other would orphan the bytes with nothing in the product naming
    // them, and the row would never be selected again.
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(db.update).toHaveBeenCalledWith({
      where: { id: 'cp_good' },
      data: { snapshotKey: null, snapshotPruned: true },
    });
    expect(usage.adjustStorageBytes).toHaveBeenCalledTimes(1);
    expect(usage.adjustStorageBytes).toHaveBeenCalledWith(-1_000);
  });

  it('control: an unguarded loop over the same rows abandons the run at the first key', async () => {
    // The shape of the code before the fix, over the same inputs, to show what the guard buys.
    let thinned = 0;
    await expect(
      (async () => {
        for (const row of ROWS) {
          if (row.snapshotKey.startsWith('/')) throw new Error('StorageKeyError');
          thinned += 1;
        }
      })(),
    ).rejects.toThrow('StorageKeyError');
    expect(thinned).toBe(0);
  });
});

describe('thinCheckpoints when a retention job fails', () => {
  it('runs the others, reports the failure, and does not report a healthy run', async () => {
    prunes.audit.mockRejectedValue(new Error('deadlock detected'));

    const result = await thinCheckpoints();

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('audit log: deadlock detected');
    expect(result.auditPruned).toBe(0);
    // The independent jobs still happened.
    expect(result.previewDeleted).toBe(5);
    expect(result.cronRunsPruned).toBe(6);
    expect(prunes.observability).toHaveBeenCalledTimes(1);
  });
});

describe('thinCheckpoints on a clean run', () => {
  it('reports a healthy run with nothing held back', async () => {
    const result = await thinCheckpoints();

    expect(result.ok).toBe(true);
    expect(result.detail).toBeNull();
    expect(result.blocked).toBe(0);
    expect(result.thinned).toBe(2);
    expect(result.retentionDays).toBe(7);
  });
});

/**
 * The other half: what it must leave alone. A checkpoint's snapshot is the only copy of that
 * version of a user's site, and thinning it is not reversible — "Restore this version" degrades
 * to code-only. The SQL `where` holds three of the four rules, but the project's *latest*
 * checkpoint is excluded in JS against a `groupBy`, so it is the one that a refactor can drop
 * without any query changing.
 */
describe('what thinCheckpoints leaves alone', () => {
  it("never thins a project's latest checkpoint, even when it is old enough", async () => {
    const latest = checkpoint('cp_latest', 'proj_only', 'snapshots/proj_only/cp_latest.zip');
    db.groupBy.mockResolvedValue([{ projectId: 'proj_only', _max: { createdAt: OLD } }]);
    db.findMany.mockResolvedValue([latest]);

    const result = await thinCheckpoints();

    // The row survives the `where` — it is old, unbookmarked and unpruned — so only the
    // latest-checkpoint rule stands between the user and losing their newest snapshot.
    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, thinned: 0, blocked: 0, reclaimedBytes: 0 });
  });

  it('never thins a bookmarked or already-pruned row that reaches the loop', async () => {
    // Both are excluded by the `where` too; the loop re-checks them, because a query that is
    // ever widened must not turn into a delete.
    db.groupBy.mockResolvedValue([
      { projectId: 'proj_a', _max: { createdAt: new Date('2026-08-18T00:00:00.000Z') } },
    ]);
    db.findMany.mockResolvedValue([
      { ...checkpoint('cp_bookmarked', 'proj_a', 'snapshots/proj_a/keep.zip'), isBookmarked: true },
      { ...checkpoint('cp_pruned', 'proj_a', 'snapshots/proj_a/gone.zip'), snapshotPruned: true },
    ]);

    const result = await thinCheckpoints();

    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(result.thinned).toBe(0);
  });

  it('asks the database only for rows outside the retention window', async () => {
    await thinCheckpoints();

    const where = db.findMany.mock.calls[0][0].where as {
      isBookmarked: boolean;
      snapshotPruned: boolean;
      createdAt: { lt: Date };
      snapshotKey: { not: null };
    };
    expect(where.isBookmarked).toBe(false);
    expect(where.snapshotPruned).toBe(false);
    expect(where.snapshotKey).toEqual({ not: null });
    // Seven days back from now, per the mocked `checkpointRetentionDays`. A cutoff computed the
    // wrong way round would hand the loop every checkpoint in the product.
    const days = (Date.now() - where.createdAt.lt.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });
});
