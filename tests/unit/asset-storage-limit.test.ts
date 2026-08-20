import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-123: every asset write — upload, generate, stock, Openverse, the import
 * rehost and the checkpoint thumbnail — goes through `persistOptimizedAsset`,
 * which incremented `Workspace.storageBytes` and never consulted the plan's
 * `storageBytesLimit`. The storage limit was enforced for checkpoints
 * (`lib/checkpoints/actions.ts`) and for nothing else, so a workspace could
 * exceed it indefinitely through images.
 */

const limits = vi.hoisted(() => ({ checkLimit: vi.fn() }));
const storage = vi.hoisted(() => ({ upload: vi.fn() }));
const usage = vi.hoisted(() => ({ adjustStorageBytes: vi.fn() }));
const optimize = vi.hoisted(() => ({ optimizeImage: vi.fn() }));
const db = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('@/lib/plans/limits', () => limits);
vi.mock('@/lib/storage', () => storage);
vi.mock('@/lib/storage/usage', () => ({
  WORKSPACE_ROW_ID: 'default',
  adjustStorageBytes: usage.adjustStorageBytes,
}));
/** Not under test here, and it pulls sharp in for real. */
vi.mock('@/lib/assets/optimize', () => optimize);
vi.mock('@/lib/db', () => ({ prisma: { projectAsset: { create: db.create } } }));

// Imported after `vi.mock`, so the module graph is built against the mocks.
const { persistOptimizedAsset } = await import('@/lib/assets/persist');

const OPTIMIZED = {
  buffer: Buffer.from('webp'),
  contentType: 'image/webp',
  ext: 'webp',
  width: 1600,
  height: 900,
  sizeBytes: 640_000,
};

beforeEach(() => {
  vi.clearAllMocks();
  optimize.optimizeImage.mockResolvedValue(OPTIMIZED);
  storage.upload.mockResolvedValue({ url: '/uploads/projects/p-1/assets/a.webp' });
  db.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'asset-1',
    ...data,
  }));
  limits.checkLimit.mockResolvedValue({ ok: true, current: 0, limit: -1 });
});

describe('persistOptimizedAsset honours the workspace storage limit', () => {
  it('refuses an image that would push the workspace past its limit', async () => {
    limits.checkLimit.mockResolvedValue({
      ok: false,
      current: 1_000,
      limit: 1_000,
      reason: 'storage',
      message: 'Workspace storage limit is used up',
    });

    await expect(
      persistOptimizedAsset({
        projectId: 'p-1',
        buffer: Buffer.from('png'),
        kind: 'uploaded',
        altText: 'A photo',
      }),
    ).rejects.toThrow(/storage limit/i);

    // Nothing is written and nothing is counted: refusing after the upload
    // would leave the object behind with no row pointing at it.
    expect(storage.upload).not.toHaveBeenCalled();
    expect(db.create).not.toHaveBeenCalled();
    expect(usage.adjustStorageBytes).not.toHaveBeenCalled();
  });

  it('checks the encoded size, not the size the caller handed in', async () => {
    await persistOptimizedAsset({
      projectId: 'p-1',
      buffer: Buffer.alloc(9_000_000),
      kind: 'uploaded',
      altText: 'A photo',
    });

    // sharp re-encodes to WebP first, so the bytes that will actually be stored
    // are the ones checked against the limit and the ones counted afterwards.
    expect(limits.checkLimit).toHaveBeenCalledWith('default', 'storage', OPTIMIZED.sizeBytes);
    expect(usage.adjustStorageBytes).toHaveBeenCalledWith(OPTIMIZED.sizeBytes);
  });

  it('stores and counts the image when the limit allows it', async () => {
    const asset = await persistOptimizedAsset({
      projectId: 'p-1',
      buffer: Buffer.from('png'),
      kind: 'stock',
      altText: 'A photo',
    });

    expect(asset).toMatchObject({ kind: 'stock', sizeBytes: OPTIMIZED.sizeBytes });
    expect(storage.upload).toHaveBeenCalledTimes(1);
    expect(usage.adjustStorageBytes).toHaveBeenCalledWith(OPTIMIZED.sizeBytes);
  });
});
