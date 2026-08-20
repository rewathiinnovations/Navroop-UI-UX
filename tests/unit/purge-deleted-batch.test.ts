import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two ways the daily hard purge did not scale (F-783).
 *
 * It loaded *every* eligible project with all its checkpoints, assets and preview builds, then
 * per project performed a publish teardown, three `listKeys` calls and one `deleteObject` per
 * key — serially, with no cap. A backlog (a bulk delete, or a week of the cron being broken)
 * therefore produced exactly one outcome: a run long enough to be killed by the request
 * timeout, every time, forever.
 *
 * And `adjustStorageBytes(-bytes)` ran *after* `prisma.project.delete`. A failure between the
 * two — a killed process, a lost connection — permanently over-counted `Workspace.storageBytes`
 * with nothing able to reconcile it, because the rows the bytes were computed from are gone.
 *
 * Goes red if: the per-run cap disappears; the remaining backlog stops being reported; or the
 * delete and the ledger decrement stop being one atomic unit.
 */

const db = vi.hoisted(() => ({
  projectFindMany: vi.fn(),
  projectCount: vi.fn(),
  projectDelete: vi.fn(),
  transaction: vi.fn(),
}));
const storage = vi.hoisted(() => ({ listKeys: vi.fn(), deleteObject: vi.fn() }));
const publish = vi.hoisted(() => ({ purgeProjectPublishResources: vi.fn() }));
const audit = vi.hoisted(() => ({ writeAudit: vi.fn() }));
const usage = vi.hoisted(() => ({ adjustStorageBytes: vi.fn() }));

vi.mock('@/lib/db', () => ({
  prisma: {
    project: {
      findMany: db.projectFindMany,
      count: db.projectCount,
      delete: db.projectDelete,
    },
    $transaction: db.transaction,
  },
}));
vi.mock('@/lib/storage', () => ({
  listKeys: storage.listKeys,
  deleteObject: storage.deleteObject,
}));
vi.mock('@/lib/storage/usage', () => ({ adjustStorageBytes: usage.adjustStorageBytes }));
vi.mock('@/lib/checkpoints/retention', () => ({ purgeDeletedDays: async () => 30 }));
vi.mock('@/lib/audit/log', () => ({ writeAudit: audit.writeAudit }));
vi.mock('@/lib/publish/cleanup', () => ({
  purgeProjectPublishResources: publish.purgeProjectPublishResources,
}));

// Dynamic: `lib/publish/cleanup` reaches Coolify, Cloudflare and GitHub at import time, so the
// module may only be evaluated after the factories above are registered.
const { purgeDeletedProjects, PURGE_PROJECT_LIMIT } = await import('@/lib/projects/purge-deleted');

const TORN_DOWN = {
  deployments: 0,
  resources: [],
  keptCloudflareZones: [],
  failures: [],
};

function projectFixture(id: string) {
  return {
    id,
    checkpoints: [{ snapshotKey: `snapshots/${id}/cp_1.zip`, snapshotBytes: 100 }],
    projectAssets: [],
    previewBuilds: [],
  };
}

/** The transaction client the purge is handed; only the calls it makes are modelled. */
function transactionClient() {
  return { project: { delete: db.projectDelete } };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  db.projectFindMany.mockResolvedValue([projectFixture('proj_1')]);
  db.projectCount.mockResolvedValue(1);
  db.projectDelete.mockResolvedValue({});
  db.transaction.mockImplementation(
    async (fn: (client: ReturnType<typeof transactionClient>) => Promise<unknown>) =>
      fn(transactionClient()),
  );
  storage.listKeys.mockResolvedValue([]);
  storage.deleteObject.mockResolvedValue(undefined);
  publish.purgeProjectPublishResources.mockResolvedValue(TORN_DOWN);
  audit.writeAudit.mockResolvedValue(undefined);
  usage.adjustStorageBytes.mockResolvedValue(undefined);
});

describe('purgeDeletedProjects is bounded per run', () => {
  it('asks for at most one batch of projects', async () => {
    await purgeDeletedProjects();

    expect(db.projectFindMany.mock.calls[0]?.[0]?.take).toBe(PURGE_PROJECT_LIMIT);
    expect(PURGE_PROJECT_LIMIT).toBeGreaterThan(0);
  });

  it('reports the backlog it did not get to, so a cap is not a silent stall', async () => {
    const batch = Array.from({ length: PURGE_PROJECT_LIMIT }, (_unused, index) =>
      projectFixture(`proj_${index}`),
    );
    db.projectFindMany.mockResolvedValue(batch);
    db.projectCount.mockResolvedValue(PURGE_PROJECT_LIMIT + 7);

    const report = await purgeDeletedProjects();

    expect(report.purged).toBe(PURGE_PROJECT_LIMIT);
    expect(report.eligible).toBe(PURGE_PROJECT_LIMIT + 7);
    expect(report.remaining).toBe(7);
  });

  it('reports no backlog when the batch drained it', async () => {
    const report = await purgeDeletedProjects();

    expect(report.remaining).toBe(0);
  });
});

describe('purgeDeletedProjects storage accounting', () => {
  it('deletes the project and decrements the ledger in one transaction', async () => {
    await purgeDeletedProjects();

    expect(db.transaction).toHaveBeenCalledTimes(1);
    // Both writes are inside the callback the transaction was given.
    expect(db.projectDelete).toHaveBeenCalledWith({ where: { id: 'proj_1' } });
    expect(usage.adjustStorageBytes).toHaveBeenCalledWith(-100, expect.anything());
  });

  it('does not delete the project when the ledger decrement fails', async () => {
    // A real transaction rolls the delete back on a throw; the fake one simply propagates,
    // which is what proves the two writes share a fate rather than being sequential awaits.
    usage.adjustStorageBytes.mockRejectedValue(new Error('deadlock detected'));
    db.transaction.mockImplementation(
      async (fn: (client: ReturnType<typeof transactionClient>) => Promise<unknown>) => {
        await fn(transactionClient());
      },
    );

    const report = await purgeDeletedProjects();

    expect(report.purged).toBe(0);
    expect(report.blocked).toBe(1);
  });

  it('counts a project as purged only after the transaction committed', async () => {
    db.transaction.mockRejectedValue(new Error('connection lost'));

    const report = await purgeDeletedProjects();

    expect(report.purged).toBe(0);
    expect(report.reclaimedBytes).toBe(0);
    expect(report.blocked).toBe(1);
  });
});
