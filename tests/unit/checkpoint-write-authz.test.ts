import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Who may write a project's checkpoint state.
 *
 * `loadProjectForWrite` has always selected `ownerId`, and only `restoreCheckpoint`
 * compared it. `previewCheckpoint` and `exitCheckpointPreview` reached the same
 * `Project.lastCode` write without the check — so any signed-in member could roll
 * another member's project back to an arbitrary earlier checkpoint, and, with no lock
 * taken either, could land that write in the middle of a running generation and bump
 * `contentVersion` underneath the generating client. `toggleCheckpointBookmark` did not
 * even fetch `ownerId`.
 *
 * Preview and exit no longer touch `lastCode` at all (F-102): they write
 * `Project.previewingCheckpointId`, and the read path serves the checkpoint's snapshot. The
 * gate did not move — a preview still changes what every client of the project is served, so
 * it is still owner-only and still taken under the project lock. What the cases below assert
 * is the new write, because guarding the old one would guard nothing.
 *
 * Storage-failure semantics for these same three functions live in
 * `checkpoint-restore-storage.test.ts`; this file only asks who is allowed through.
 *
 * Modules under test are pulled in with `await import` because a static import would
 * bind before `vi.mock` registers.
 */

const db = vi.hoisted(() => ({
  projectFindFirst: vi.fn(),
  projectUpdate: vi.fn(),
  checkpointFindFirst: vi.fn(),
  checkpointUpdate: vi.fn(),
  executeRaw: vi.fn(),
}));
const actor = vi.hoisted(() => ({ peek: vi.fn() }));
const lock = vi.hoisted(() => ({ withProjectLock: vi.fn(), bumpContentVersion: vi.fn() }));
const snapshot = vi.hoisted(() => ({ readSnapshot: vi.fn() }));

vi.mock('@/lib/db', () => ({
  prisma: {
    project: { findFirst: db.projectFindFirst, update: db.projectUpdate },
    checkpoint: { findFirst: db.checkpointFindFirst, update: db.checkpointUpdate },
    // Preview and exit write `Project.previewingCheckpointId` with raw SQL, because the
    // generated client may predate the column (`lib/checkpoints/preview-state.ts`).
    $executeRaw: db.executeRaw,
  },
}));

vi.mock('@/lib/projects/plan', () => ({ peekActor: actor.peek }));

/** next-auth cannot resolve `next/server` outside the Next runtime; `peekActor` supplies
 *  the actor, so `getSessionUser` is never reached. */
vi.mock('@/lib/auth', () => ({ getSessionUser: async () => null }));

vi.mock('@/lib/projects/lock', () => ({
  bumpContentVersion: lock.bumpContentVersion,
  withProjectLock: lock.withProjectLock,
}));

/** No object storage in a unit test. `SnapshotReadError` is a class because the module
 *  under test branches on `instanceof`. */
vi.mock('@/lib/checkpoints/snapshot', () => ({
  readSnapshot: snapshot.readSnapshot,
  captureFileSnapshot: vi.fn(),
  writeSnapshot: vi.fn(),
  snapshotsEqual: vi.fn(() => false),
  SnapshotReadError: class SnapshotReadError extends Error {},
}));

const OWNER = { id: 'u-owner', email: 'owner@example.com', name: 'Owner', role: 'MEMBER' as const };
const OTHER = { id: 'u-other', email: 'other@example.com', name: 'Other', role: 'MEMBER' as const };
const ADMIN = { id: 'u-admin', email: 'admin@example.com', name: 'Admin', role: 'ADMIN' as const };

const PROJECT = 'p-cp-authz';
const CHECKPOINT = 'cp-authz';

const FILES = [{ path: 'src/App.jsx', content: 'export default () => <h1>Hi</h1>' }];

beforeEach(() => {
  vi.clearAllMocks();
  actor.peek.mockReturnValue(OWNER);
  db.projectFindFirst.mockResolvedValue({ id: PROJECT, ownerId: OWNER.id, previewUrl: null });
  db.checkpointFindFirst.mockResolvedValue({
    id: CHECKPOINT,
    projectId: PROJECT,
    label: 'Latest generation',
    thumbnailUrl: null,
    createdAt: new Date('2026-08-18T02:00:00.000Z'),
    trigger: 'followup',
    sourceMessage: null,
    isBookmarked: false,
    snapshotPruned: false,
    snapshotKey: `snapshots/${PROJECT}/${CHECKPOINT}.json.gz`,
    fileSnapshot: null,
  });
  db.projectUpdate.mockResolvedValue(undefined);
  db.executeRaw.mockResolvedValue(1);
  db.checkpointUpdate.mockImplementation(async () => ({
    ...(await db.checkpointFindFirst()),
    isBookmarked: true,
  }));
  snapshot.readSnapshot.mockResolvedValue(FILES);
  lock.withProjectLock.mockImplementation(
    async (_id: string, _userId: string, _reason: string, run: () => unknown) => ({
      ok: true as const,
      value: await run(),
    }),
  );
});

const CONTENT_WRITES = [
  [
    'previewCheckpoint',
    async () => (await import('@/lib/checkpoints/actions')).previewCheckpoint(PROJECT, CHECKPOINT),
  ],
  [
    'exitCheckpointPreview',
    async () => (await import('@/lib/checkpoints/actions')).exitCheckpointPreview(PROJECT),
  ],
  [
    'restoreCheckpoint',
    async () => (await import('@/lib/checkpoints/actions')).restoreCheckpoint(PROJECT, CHECKPOINT),
  ],
] as const;

describe("a non-owning member cannot write another member's project", () => {
  for (const [name, call] of CONTENT_WRITES) {
    it(`${name} answers 403 and writes nothing`, async () => {
      actor.peek.mockReturnValue(OTHER);

      const result = await call();

      // The string matters: the client throws it verbatim into the user's chat.
      expect(result).toMatchObject({
        ok: false,
        status: 403,
        error: 'This project belongs to someone else',
      });
      expect(db.projectUpdate).not.toHaveBeenCalled();
      // Preview and exit write the previewing pointer with raw SQL rather than through the
      // `project` delegate, so the refusal has to cover that too.
      expect(db.executeRaw).not.toHaveBeenCalled();
      // The gate must also stop short of the lock: acquiring it would park the
      // owner's own next generation behind a request that is about to be refused.
      expect(lock.withProjectLock).not.toHaveBeenCalled();
    });
  }

  it('toggleCheckpointBookmark answers 403 and leaves the bookmark alone', async () => {
    actor.peek.mockReturnValue(OTHER);
    const { toggleCheckpointBookmark } = await import('@/lib/checkpoints/actions');

    const result = await toggleCheckpointBookmark(PROJECT, CHECKPOINT);

    expect(result).toMatchObject({
      ok: false,
      status: 403,
      error: 'This project belongs to someone else',
    });
    expect(db.checkpointUpdate).not.toHaveBeenCalled();
  });

  it('fetches ownerId for the bookmark toggle, so the gate has something to compare', async () => {
    actor.peek.mockReturnValue(OTHER);
    const { toggleCheckpointBookmark } = await import('@/lib/checkpoints/actions');

    await toggleCheckpointBookmark(PROJECT, CHECKPOINT);

    expect(db.projectFindFirst.mock.calls[0]?.[0]?.select).toMatchObject({ ownerId: true });
  });
});

describe('the owner and an ADMIN still get through', () => {
  for (const who of [OWNER, ADMIN]) {
    it(`previewCheckpoint marks the previewed version under the project lock for ${who.role}`, async () => {
      // Control: the 403s above must not be a path that is simply broken.
      actor.peek.mockReturnValue(who);

      const result = await (
        await import('@/lib/checkpoints/actions')
      ).previewCheckpoint(PROJECT, CHECKPOINT);

      expect(result.ok).toBe(true);
      // A preview no longer writes `Project.lastCode` (F-102). It writes only the pointer, so
      // that is what the owner gate is guarding now.
      expect(db.projectUpdate).not.toHaveBeenCalled();
      expect(db.executeRaw).toHaveBeenCalledTimes(1);
      // The lock is the second half of the original fix. It stays: a preview changes what
      // every client of this project is served, so it must not land mid-generation.
      expect(lock.withProjectLock).toHaveBeenCalledTimes(1);
      expect(lock.withProjectLock.mock.calls[0]?.[2]).toBe('generation');
    });

    it(`exitCheckpointPreview clears the pointer under the project lock for ${who.role}`, async () => {
      actor.peek.mockReturnValue(who);

      const result = await (
        await import('@/lib/checkpoints/actions')
      ).exitCheckpointPreview(PROJECT);

      expect(result.ok).toBe(true);
      expect(db.projectUpdate).not.toHaveBeenCalled();
      expect(db.executeRaw).toHaveBeenCalledTimes(1);
      expect(lock.withProjectLock).toHaveBeenCalledTimes(1);
    });
  }
});

describe('a held lock is reported, not ignored', () => {
  it('previewCheckpoint surfaces the same 409 restore does', async () => {
    lock.withProjectLock.mockResolvedValue({
      ok: false as const,
      heldBy: { id: 'u-owner', name: 'Owner', email: OWNER.email },
      expiresAt: new Date('2026-08-18T02:05:00.000Z'),
    });
    const { previewCheckpoint } = await import('@/lib/checkpoints/actions');

    const result = await previewCheckpoint(PROJECT, CHECKPOINT);

    expect(result).toMatchObject({ ok: false, status: 409 });
    // The workspace detects a lock conflict by this wording; a different string
    // would degrade it to a generic toast.
    expect((result as { error: string }).error).toContain('is working on this project');
  });
});
