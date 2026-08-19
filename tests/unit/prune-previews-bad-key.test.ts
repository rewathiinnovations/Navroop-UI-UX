import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What one unusable storage key is allowed to cost the preview prune.
 *
 * `normalizeKey` throws on a key it cannot resolve (it used to silently rewrite, which is how
 * `previews/{projectId}/{buildId}/../../../.env` became an arbitrary file read). A stored
 * `storagePrefix` or a key listed under it can therefore reject, and the delete loop had no
 * per-key handling: the first bad key aborted the whole run, so every project behind it in
 * the loop was skipped and the same key poisoned every subsequent tick.
 *
 * Goes red if a bad key stops the run, or if a build row is deleted while objects it is the
 * only pointer to are still in storage.
 */

const db = vi.hoisted(() => ({
  projectFindMany: vi.fn(),
  checkpointFindMany: vi.fn(),
  queryRaw: vi.fn(),
  previewFindMany: vi.fn(),
  previewDelete: vi.fn(),
}));
const storage = vi.hoisted(() => ({ listKeys: vi.fn(), deleteObject: vi.fn() }));
const usage = vi.hoisted(() => ({ adjustStorageBytes: vi.fn() }));
const retention = vi.hoisted(() => ({ previewBuildsToDelete: vi.fn() }));

vi.mock('@/lib/db', () => ({
  prisma: {
    project: { findMany: db.projectFindMany },
    checkpoint: { findMany: db.checkpointFindMany },
    previewBuild: { findMany: db.previewFindMany, delete: db.previewDelete },
    $queryRaw: db.queryRaw,
  },
}));
vi.mock('@/lib/storage', () => ({
  listKeys: storage.listKeys,
  deleteObject: storage.deleteObject,
}));
vi.mock('@/lib/storage/usage', () => ({ adjustStorageBytes: usage.adjustStorageBytes }));
vi.mock('@/lib/preview/retention', () => ({
  previewBuildsToDelete: retention.previewBuildsToDelete,
}));

import { prunePreviewBuilds } from '@/lib/preview/prune';

function buildFixture(id: string) {
  return {
    id,
    projectId: 'proj_1',
    checkpointId: `cp_${id}`,
    storagePrefix: `previews/proj_1/${id}/`,
    totalBytes: 50,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db.projectFindMany.mockResolvedValue([{ id: 'proj_1' }]);
  db.checkpointFindMany.mockResolvedValue([]);
  db.queryRaw.mockResolvedValue([{ activePreviewBuildId: null }]);
  db.previewFindMany.mockResolvedValue([buildFixture('pb_bad'), buildFixture('pb_ok')]);
  db.previewDelete.mockResolvedValue(buildFixture('pb_ok'));
  storage.listKeys.mockImplementation(async (prefix: string) => [`${prefix}index.html`]);
  storage.deleteObject.mockResolvedValue(undefined);
  usage.adjustStorageBytes.mockResolvedValue(undefined);
  retention.previewBuildsToDelete.mockReturnValue(['pb_bad', 'pb_ok']);
});

describe('prunePreviewBuilds with an unusable storage key', () => {
  it('keeps the row whose object it could not delete, and prunes the next one anyway', async () => {
    storage.deleteObject.mockImplementation(async (key: string) =>
      key.includes('pb_bad')
        ? Promise.reject(new Error('Unsafe storage key: walks above the storage root'))
        : undefined,
    );

    const result = await prunePreviewBuilds();

    // The row is the only pointer to `storagePrefix`, so deleting it would orphan the bytes
    // with nothing in the product naming them.
    expect(db.previewDelete).toHaveBeenCalledTimes(1);
    expect(db.previewDelete).toHaveBeenCalledWith({ where: { id: 'pb_ok' } });
    expect(result).toEqual({ deleted: 1, reclaimedBytes: 50 });
  });

  it('keeps the row when the prefix itself cannot be listed', async () => {
    storage.listKeys.mockImplementation(async (prefix: string) =>
      prefix.includes('pb_bad')
        ? Promise.reject(new Error('Unsafe storage key: is an absolute path'))
        : [`${prefix}index.html`],
    );

    const result = await prunePreviewBuilds();

    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
    expect(db.previewDelete).toHaveBeenCalledWith({ where: { id: 'pb_ok' } });
    expect(result).toEqual({ deleted: 1, reclaimedBytes: 50 });
  });
});
