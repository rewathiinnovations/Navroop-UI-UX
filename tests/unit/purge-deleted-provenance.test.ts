import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What a hard purge is allowed to destroy, and in what order.
 *
 * `Job.project` is `onDelete: Cascade` (`prisma/schema.prisma`), so `prisma.project.delete`
 * takes every PUBLISH job's `resourceIds` — the creation receipts the orphan cron needs,
 * because it will only delete a cloud resource whose id this system recorded creating
 * (name-shape deletion is not coming back: it deleted operators' own `www`, `api` and `mail`
 * records). The old order tore publish resources down inside a try/catch that only warned,
 * then deleted the Project regardless, so a Coolify 502 left a container running and billing
 * whose uuid existed in no Deployment row and no Job row. Nothing could ever reap it.
 *
 * Goes red if the project is deleted while a provider still holds a resource, if the
 * `project.hard_purge` audit entry stops naming the ids (or stops being written before the
 * delete), or if one un-normalizable stored key aborts the run instead of costing one object.
 */

const db = vi.hoisted(() => ({
  projectFindMany: vi.fn(),
  projectDelete: vi.fn(),
}));
const storage = vi.hoisted(() => ({ listKeys: vi.fn(), deleteObject: vi.fn() }));
const publish = vi.hoisted(() => ({ purgeProjectPublishResources: vi.fn() }));
const audit = vi.hoisted(() => ({ writeAudit: vi.fn() }));
const usage = vi.hoisted(() => ({ adjustStorageBytes: vi.fn() }));

vi.mock('@/lib/db', () => ({
  prisma: {
    project: { findMany: db.projectFindMany, delete: db.projectDelete },
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

// Dynamic: `lib/publish/cleanup` reaches Coolify, Cloudflare and GitHub at import time, so
// the module may only be evaluated after the factories above are registered.
const { purgeDeletedProjects } = await import('@/lib/projects/purge-deleted');

function projectFixture(id: string) {
  return {
    id,
    checkpoints: [{ snapshotKey: `snapshots/${id}/cp_1.zip`, snapshotBytes: 100 }],
    projectAssets: [{ storageKey: `projects/${id}/logo.png`, sizeBytes: 20 }],
    // The build's pre-gzip byte sum (`markReady`, lib/preview/build.ts); the row
    // itself is cascaded away by the delete, so the purge is its last reader.
    previewBuilds: [{ totalBytes: 300 }],
  };
}

const PROJECT = projectFixture('proj_1');

const TORN_DOWN = {
  deployments: 1,
  resources: [
    {
      deploymentId: 'dep_1',
      slug: 'shop',
      kind: 'LIVE',
      coolifyAppUuid: 'coolify-app-1',
      dnsRecordId: 'rec_1',
      repoFullName: 'navroop/shop',
    },
  ],
  keptCloudflareZones: [{ hostname: 'shop.client.test', zoneId: 'zone_1' }],
  failures: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  db.projectFindMany.mockResolvedValue([PROJECT]);
  db.projectDelete.mockResolvedValue(PROJECT);
  storage.listKeys.mockResolvedValue([]);
  storage.deleteObject.mockResolvedValue(undefined);
  publish.purgeProjectPublishResources.mockResolvedValue(TORN_DOWN);
  audit.writeAudit.mockResolvedValue(undefined);
  usage.adjustStorageBytes.mockResolvedValue(undefined);
});

describe('purgeDeletedProjects provenance', () => {
  it('names every resource id in the audit entry before the cascade destroys the rows', async () => {
    const result = await purgeDeletedProjects();

    expect(result).toMatchObject({ purged: 1, blocked: 0, reclaimedBytes: 420 });
    expect(audit.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'project.hard_purge',
        targetType: 'project',
        targetId: 'proj_1',
        after: {
          deployments: TORN_DOWN.resources,
          keptCloudflareZones: TORN_DOWN.keptCloudflareZones,
          reclaimedBytes: 420,
        },
      }),
    );
    // Order is the whole point: written after the delete it would be written after the
    // cascade had already taken the ids away.
    const auditOrder = audit.writeAudit.mock.invocationCallOrder[0] ?? 0;
    const deleteOrder = db.projectDelete.mock.invocationCallOrder[0] ?? 0;
    expect(auditOrder).toBeLessThan(deleteOrder);
  });

  it('refuses to delete the project while a provider still holds a resource', async () => {
    publish.purgeProjectPublishResources.mockResolvedValue({
      ...TORN_DOWN,
      failures: ['dep_1:coolify'],
    });

    const result = await purgeDeletedProjects();

    // The Deployment row survives a failed teardown (`destroyDeployment`), so leaving the
    // project alone keeps the pointer and the next run retries the same teardown. Deleting
    // it here is what produced a container billing forever with its uuid recorded nowhere.
    expect(db.projectDelete).not.toHaveBeenCalled();
    expect(audit.writeAudit).not.toHaveBeenCalled();
    expect(usage.adjustStorageBytes).not.toHaveBeenCalled();
    expect(result).toMatchObject({ purged: 0, blocked: 1, reclaimedBytes: 0 });
  });

  it('refuses to delete the project when the teardown threw', async () => {
    publish.purgeProjectPublishResources.mockRejectedValue(new Error('Coolify unreachable'));

    const result = await purgeDeletedProjects();

    expect(db.projectDelete).not.toHaveBeenCalled();
    expect(result).toMatchObject({ purged: 0, blocked: 1 });
  });
});

describe('purgeDeletedProjects storage keys', () => {
  it('lets one un-normalizable key cost one object, not the whole run', async () => {
    db.projectFindMany.mockResolvedValue([projectFixture('proj_bad'), projectFixture('proj_ok')]);
    // `normalizeKey` throws on a key it cannot resolve (it used to silently rewrite), and a
    // stored `snapshotKey` from an older build can be in a shape it refuses.
    storage.deleteObject.mockImplementation(async (key: string) =>
      key.startsWith('snapshots/proj_bad/')
        ? Promise.reject(new Error('Unsafe storage key: walks above the storage root'))
        : undefined,
    );

    const result = await purgeDeletedProjects();

    // The poisoned project is held back for the next run; the one behind it still purges.
    expect(result).toMatchObject({ purged: 1, blocked: 1 });
    expect(db.projectDelete).toHaveBeenCalledTimes(1);
    expect(db.projectDelete).toHaveBeenCalledWith({ where: { id: 'proj_ok' } });
    // Every key was still attempted, including the ones after the bad one.
    expect(storage.deleteObject.mock.calls.map((call) => call[0])).toEqual([
      'snapshots/proj_bad/cp_1.zip',
      'projects/proj_bad/logo.png',
      'snapshots/proj_ok/cp_1.zip',
      'projects/proj_ok/logo.png',
    ]);
  });

  it('reclaims static preview objects and their bytes — the cascade destroys the only pointer', async () => {
    // `previews/{projectId}/{buildId}/…` is written by lib/preview/build.ts;
    // `PreviewBuild.storagePrefix` is the only record those objects exist, and
    // `prisma.project.delete` cascades the rows away. Before the purge listed
    // this prefix the objects leaked forever and `storageBytes` only ever grew.
    storage.listKeys.mockImplementation(async (prefix: string) =>
      prefix === 'previews/proj_1/'
        ? ['previews/proj_1/build_1/index.html', 'previews/proj_1/build_1/assets/app.js']
        : [],
    );

    const result = await purgeDeletedProjects();

    expect(result).toMatchObject({ purged: 1, blocked: 0, reclaimedBytes: 420 });
    const deleted = storage.deleteObject.mock.calls.map((call) => call[0]);
    expect(deleted).toContain('previews/proj_1/build_1/index.html');
    expect(deleted).toContain('previews/proj_1/build_1/assets/app.js');
    // 100 snapshot + 20 asset + 300 preview bytes leave the workspace ledger.
    expect(usage.adjustStorageBytes).toHaveBeenCalledWith(-420);
  });

  it('holds the project back when the object listing fails, and keeps going', async () => {
    db.projectFindMany.mockResolvedValue([projectFixture('proj_bad'), projectFixture('proj_ok')]);
    storage.listKeys.mockImplementation(async (prefix: string) =>
      prefix.includes('proj_bad') ? Promise.reject(new Error('S3 timeout')) : [],
    );

    const result = await purgeDeletedProjects();

    expect(result).toMatchObject({ purged: 1, blocked: 1 });
    expect(db.projectDelete).toHaveBeenCalledWith({ where: { id: 'proj_ok' } });
  });
});
