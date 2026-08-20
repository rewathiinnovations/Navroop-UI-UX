import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-126: deleting an asset was `deleteObject` → `prisma.projectAsset.delete` →
 * `adjustStorageBytes` with no transaction and no error handling. A database
 * error in the window left a row pointing at an object that no longer existed —
 * a permanently broken tile in the Assets panel — while the storage counter was
 * never decremented. A row-less object is reclaimed by the project purge
 * (`lib/projects/purge-deleted.ts` deletes the whole `projects/{id}/` prefix);
 * an object-less row is reclaimed by nothing.
 */

const db = vi.hoisted(() => ({
  projectFindFirst: vi.fn(),
  assetFindFirst: vi.fn(),
  assetDelete: vi.fn(),
}));
const auth = vi.hoisted(() => ({ getSessionUser: vi.fn() }));
const storage = vi.hoisted(() => ({ deleteObject: vi.fn() }));
const usage = vi.hoisted(() => ({ adjustStorageBytes: vi.fn() }));
const track = vi.hoisted(() => ({ trackFailure: vi.fn() }));

vi.mock('@/lib/db', () => ({
  prisma: {
    project: { findFirst: db.projectFindFirst },
    projectAsset: { findFirst: db.assetFindFirst, delete: db.assetDelete },
  },
}));
/** next-auth cannot resolve `next/server` outside the Next runtime. */
vi.mock('@/lib/auth', () => ({ getSessionUser: auth.getSessionUser }));
vi.mock('@/lib/storage', () => storage);
vi.mock('@/lib/storage/usage', () => ({
  WORKSPACE_ROW_ID: 'default',
  adjustStorageBytes: usage.adjustStorageBytes,
}));
vi.mock('@/lib/observability/track', () => track);
/** Not under test, and they pull sharp and the providers in for real. */
vi.mock('@/lib/assets/persist', () => ({ persistOptimizedAsset: vi.fn() }));
vi.mock('@/lib/assets/generate-image', () => ({ generateImage: vi.fn() }));
vi.mock('@/lib/assets/stock-photo', () => ({ searchStockPhoto: vi.fn() }));
vi.mock('@/lib/plans/limits', () => ({ checkCredits: vi.fn(), consumeCredits: vi.fn() }));

// Imported after `vi.mock`, so the module graph is built against the mocks.
const { deleteProjectAsset } = await import('@/lib/assets/actions');

const OWNER = { id: 'u-owner', email: 'owner@example.com', name: 'Owner', role: 'MEMBER' as const };
const PROJECT = 'p-assets';
const ASSET = {
  id: 'asset_1',
  projectId: PROJECT,
  storageKey: 'projects/p-assets/assets/a.webp',
  sizeBytes: 4_096,
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.getSessionUser.mockResolvedValue(OWNER);
  db.projectFindFirst.mockResolvedValue({ id: PROJECT, ownerId: OWNER.id });
  db.assetFindFirst.mockResolvedValue(ASSET);
  db.assetDelete.mockResolvedValue(ASSET);
  storage.deleteObject.mockResolvedValue(undefined);
});

describe('deleteProjectAsset orders its writes so a failure is recoverable', () => {
  it('deletes the row before the object', async () => {
    const order: string[] = [];
    db.assetDelete.mockImplementation(async () => {
      order.push('row');
      return ASSET;
    });
    storage.deleteObject.mockImplementation(async () => {
      order.push('object');
    });

    const result = await deleteProjectAsset(PROJECT, ASSET.id);

    expect(result).toMatchObject({ ok: true });
    expect(order).toEqual(['row', 'object']);
    expect(usage.adjustStorageBytes).toHaveBeenCalledWith(-ASSET.sizeBytes);
  });

  it('leaves the object alone when the row delete fails', async () => {
    db.assetDelete.mockRejectedValue(new Error('deadlock detected'));

    const result = await deleteProjectAsset(PROJECT, ASSET.id);

    expect(result).toMatchObject({ ok: false, status: 500 });
    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(usage.adjustStorageBytes).not.toHaveBeenCalled();
    expect(track.trackFailure).toHaveBeenCalledWith(
      'assets.delete_row_failed',
      expect.any(Error),
      expect.objectContaining({ action: 'asset_delete', assetId: ASSET.id }),
    );
  });

  it('does not decrement bytes that are still stored, and reports the orphan', async () => {
    storage.deleteObject.mockRejectedValue(new Error('S3 timeout'));

    const result = await deleteProjectAsset(PROJECT, ASSET.id);

    // The asset is gone as far as the user is concerned: the row is deleted, so
    // the panel no longer shows it and there is nothing left to retry against.
    expect(result).toMatchObject({ ok: true });
    // The bytes are still occupied, so the counter must keep counting them —
    // decrementing here is how the storage total drifts below reality.
    expect(usage.adjustStorageBytes).not.toHaveBeenCalled();
    expect(track.trackFailure).toHaveBeenCalledWith(
      'assets.orphan_object',
      expect.any(Error),
      expect.objectContaining({
        action: 'asset_delete',
        storageKey: ASSET.storageKey,
        sizeBytes: ASSET.sizeBytes,
      }),
    );
  });

  it('still refuses an asset that belongs to another project', async () => {
    db.assetFindFirst.mockResolvedValue(null);

    const result = await deleteProjectAsset(PROJECT, 'asset_other');

    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(db.assetDelete).not.toHaveBeenCalled();
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });
});
