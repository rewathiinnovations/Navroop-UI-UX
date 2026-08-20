import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A checkpoint write that fails half-way must leave nothing behind.
 *
 * The order is: upload the gzip object, then point the row at it, then add its bytes to
 * the workspace total. If the row update throws, the existing rollback deleted the
 * Checkpoint row and stopped there — the object stayed at
 * `snapshots/{projectId}/{checkpointId}.json.gz` for a checkpoint id that no longer
 * exists, and `adjustStorageBytes` never ran, so those bytes were unreachable *and*
 * uncounted. Only the project-purge cron ever lists that prefix, so they were reclaimed
 * on project deletion and never otherwise (F-109).
 *
 * Goes red if the object delete disappears from the rollback, if the row survives a
 * failed write, or if a failed write starts counting bytes.
 */

const db = vi.hoisted(() => ({
  projectFindFirst: vi.fn(),
  projectUpdate: vi.fn(),
  checkpointCreate: vi.fn(),
  checkpointUpdate: vi.fn(),
  checkpointDelete: vi.fn(),
  checkpointFindFirst: vi.fn(),
  checkpointFindUniqueOrThrow: vi.fn(),
}));
const storage = vi.hoisted(() => ({ deleteObject: vi.fn(), adjustStorageBytes: vi.fn() }));
const snapshot = vi.hoisted(() => ({ write: vi.fn(), capture: vi.fn(), read: vi.fn() }));
const limits = vi.hoisted(() => ({ checkLimit: vi.fn() }));

vi.mock('@/lib/db', () => ({
  prisma: {
    project: { findFirst: db.projectFindFirst, update: db.projectUpdate },
    checkpoint: {
      create: db.checkpointCreate,
      update: db.checkpointUpdate,
      delete: db.checkpointDelete,
      findFirst: db.checkpointFindFirst,
      findUniqueOrThrow: db.checkpointFindUniqueOrThrow,
    },
  },
  Prisma: { DbNull: null },
}));

vi.mock('@/generated/prisma', () => ({ Prisma: { DbNull: null } }));
vi.mock('@/lib/storage', () => ({ deleteObject: storage.deleteObject }));
vi.mock('@/lib/storage/usage', () => ({
  adjustStorageBytes: storage.adjustStorageBytes,
  WORKSPACE_ROW_ID: 'ws_default',
}));
vi.mock('@/lib/plans/limits', () => ({ checkLimit: limits.checkLimit }));
vi.mock('@/lib/checkpoints/snapshot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/checkpoints/snapshot')>();
  return {
    ...actual,
    captureFileSnapshot: snapshot.capture,
    readSnapshot: snapshot.read,
    writeSnapshot: snapshot.write,
  };
});
vi.mock('@/lib/auth', () => ({ getSessionUser: async () => null }));
vi.mock('@/lib/projects/plan', () => ({
  peekActor: () => ({ id: 'user_owner', role: 'MEMBER', email: 'owner@example.com' }),
}));
vi.mock('@/lib/generation/conversation-state', () => ({ peekConversationState: () => null }));

const { createCheckpoint } = await import('@/lib/checkpoints/actions.ts');
const { snapshotObjectKey } = await import('@/lib/checkpoints/snapshot.ts');

const PROJECT = 'proj_partial_write';
const CHECKPOINT = 'cp_partial_write';
const FILES = [{ path: 'src/App.jsx', content: 'export default function App(){return null}' }];

beforeEach(() => {
  for (const mock of [
    ...Object.values(db),
    ...Object.values(storage),
    ...Object.values(snapshot),
    ...Object.values(limits),
  ]) {
    mock.mockReset();
  }
  snapshot.capture.mockResolvedValue(FILES);
  limits.checkLimit.mockResolvedValue({ ok: true });
  snapshot.write.mockResolvedValue({
    snapshotKey: snapshotObjectKey(PROJECT, CHECKPOINT),
    snapshotBytes: 512,
    snapshotFileCount: 1,
  });
  db.checkpointCreate.mockResolvedValue({ id: CHECKPOINT });
  db.checkpointDelete.mockResolvedValue(undefined);
  db.checkpointUpdate.mockResolvedValue(undefined);
  db.checkpointFindUniqueOrThrow.mockResolvedValue({ id: CHECKPOINT });
  storage.deleteObject.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createCheckpoint rollback', () => {
  it('deletes the uploaded object when the row cannot be pointed at it', async () => {
    db.checkpointUpdate.mockRejectedValue(new Error('connection terminated'));

    await expect(
      createCheckpoint(PROJECT, { trigger: 'followup', sourceMessage: 'add a hero' }),
    ).rejects.toThrow(/connection terminated/);

    expect(storage.deleteObject).toHaveBeenCalledWith(snapshotObjectKey(PROJECT, CHECKPOINT));
    expect(db.checkpointDelete).toHaveBeenCalledWith({ where: { id: CHECKPOINT } });
    // Bytes that were rolled back must not be counted against the workspace.
    expect(storage.adjustStorageBytes).not.toHaveBeenCalled();
  });

  it('deletes the uploaded object when the byte count cannot be recorded', async () => {
    storage.adjustStorageBytes.mockRejectedValue(new Error('usage row locked'));

    await expect(createCheckpoint(PROJECT, { trigger: 'followup' })).rejects.toThrow(
      /usage row locked/,
    );

    expect(storage.deleteObject).toHaveBeenCalledWith(snapshotObjectKey(PROJECT, CHECKPOINT));
    expect(db.checkpointDelete).toHaveBeenCalled();
  });

  it('still fails the write when the object delete also fails', async () => {
    db.checkpointUpdate.mockRejectedValue(new Error('connection terminated'));
    storage.deleteObject.mockRejectedValue(new Error('storage is down too'));

    // The original fault is what the caller has to see; a failed cleanup is logged.
    await expect(createCheckpoint(PROJECT, { trigger: 'followup' })).rejects.toThrow(
      /connection terminated/,
    );
    expect(db.checkpointDelete).toHaveBeenCalled();
  });

  it('rolls the row back over the storage limit without leaving an object', async () => {
    limits.checkLimit.mockResolvedValue({
      ok: false,
      message: 'Workspace storage limit is used up',
    });

    await expect(createCheckpoint(PROJECT, { trigger: 'followup' })).rejects.toThrow(/storage/i);

    // Nothing was uploaded on this path, and `deleteObject` is idempotent for a key that
    // was never written — what matters is that the row goes and the bytes are not counted.
    expect(snapshot.write).not.toHaveBeenCalled();
    expect(db.checkpointDelete).toHaveBeenCalled();
    expect(storage.adjustStorageBytes).not.toHaveBeenCalled();
  });

  // Control: the happy path still writes, counts and keeps everything. Without this the
  // assertions above could pass on a `createCheckpoint` that never succeeds at all.
  it('control: a clean write keeps the row, the object and the byte count', async () => {
    const created = await createCheckpoint(PROJECT, { trigger: 'followup' });

    expect(created).toEqual({ id: CHECKPOINT });
    expect(db.checkpointUpdate).toHaveBeenCalledTimes(1);
    expect(storage.adjustStorageBytes).toHaveBeenCalledWith(512);
    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(db.checkpointDelete).not.toHaveBeenCalled();
  });
});
