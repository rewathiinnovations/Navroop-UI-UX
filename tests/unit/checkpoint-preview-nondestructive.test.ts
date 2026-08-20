import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-102: "Preview this version" must not roll the project back.
 *
 * `previewCheckpoint` wrote the old snapshot straight into `Project.lastCode` — the row
 * the product renders, exports, publishes and checkpoints from — and the only record that
 * the write was meant to be temporary was a `useState` in `useCheckpoints`. One reload and
 * the project silently *was* the old version: publish and ZIP export served it, and the
 * next generation built on it.
 *
 * The fix has two halves and both are pinned here:
 *
 *  - a preview writes no files at all. It records `Project.previewingCheckpointId` and the
 *    read path serves that checkpoint's snapshot, so the live site is untouched and
 *    nothing has to be undone.
 *  - the flag is a column, so it survives a reload; `getCheckpoints` reports it, which is
 *    what lets the workspace say "you are looking at v3" after F5 instead of forgetting.
 *
 * A storage failure on the preview read stays a 503. Serving `lastCode` under a
 * "viewing v3" banner would be the same collapse of absent/unreadable/broken this audit
 * keeps finding.
 *
 * Modules under test are pulled in with `await import` because a static import would bind
 * before `vi.mock` registers — the same reason the sibling checkpoint suites do it.
 */

const db = vi.hoisted(() => ({
  projectFindFirst: vi.fn(),
  projectUpdate: vi.fn(),
  checkpointFindFirst: vi.fn(),
  checkpointFindMany: vi.fn(),
  checkpointCreate: vi.fn(),
  checkpointUpdate: vi.fn(),
  checkpointDelete: vi.fn(),
  checkpointFindUniqueOrThrow: vi.fn(),
  executeRaw: vi.fn(),
  queryRaw: vi.fn(),
}));
const actor = vi.hoisted(() => ({ peek: vi.fn() }));
const lock = vi.hoisted(() => ({ withProjectLock: vi.fn(), bumpContentVersion: vi.fn() }));
const snapshot = vi.hoisted(() => ({ readSnapshot: vi.fn(), captureFileSnapshot: vi.fn() }));

vi.mock('@/lib/db', () => ({
  prisma: {
    project: { findFirst: db.projectFindFirst, update: db.projectUpdate },
    checkpoint: {
      findFirst: db.checkpointFindFirst,
      findMany: db.checkpointFindMany,
      create: db.checkpointCreate,
      update: db.checkpointUpdate,
      delete: db.checkpointDelete,
      findUniqueOrThrow: db.checkpointFindUniqueOrThrow,
    },
    $executeRaw: db.executeRaw,
    $queryRaw: db.queryRaw,
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
vi.mock('@/lib/signals/collect', () => ({ recordRevertRate: vi.fn() }));

/** No object storage in a unit test. A class because the code branches on `instanceof`. */
class FakeSnapshotReadError extends Error {}

vi.mock('@/lib/checkpoints/snapshot', () => ({
  readSnapshot: snapshot.readSnapshot,
  captureFileSnapshot: snapshot.captureFileSnapshot,
  writeSnapshot: async () => ({ snapshotKey: 'k', snapshotBytes: 10, snapshotFileCount: 1 }),
  snapshotObjectKey: () => 'k',
  snapshotsEqual: () => true,
  SnapshotReadError: FakeSnapshotReadError,
}));
vi.mock('@/lib/plans/limits', () => ({ checkLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/storage/usage', () => ({
  adjustStorageBytes: async () => undefined,
  WORKSPACE_ROW_ID: 'default',
}));
vi.mock('@/lib/storage', () => ({ deleteObject: async () => undefined }));

const OWNER = { id: 'u-owner', email: 'owner@example.com', name: 'Owner', role: 'MEMBER' as const };
const PROJECT = 'p-preview';
const CHECKPOINT = 'cp-old';

const OLD_FILES = [{ path: 'src/App.jsx', content: '<h1>v1</h1>' }];
const LIVE_LAST_CODE = JSON.stringify({ 'src/App.jsx': '<h1>v9 — the live site</h1>' });

const CHECKPOINT_ROW = {
  id: CHECKPOINT,
  projectId: PROJECT,
  label: 'First build',
  thumbnailUrl: null,
  createdAt: new Date('2026-08-18T02:00:00.000Z'),
  trigger: 'initial',
  sourceMessage: null,
  isBookmarked: false,
  snapshotPruned: false,
  snapshotKey: `snapshots/${PROJECT}/${CHECKPOINT}.json.gz`,
  fileSnapshot: null,
};

/**
 * Reassembles a tagged-template statement so a test can read the SQL that was sent.
 * `prisma.$executeRaw` receives `(strings, ...values)`; the interpolations are bound
 * parameters, so they are asserted separately from the text.
 */
function rawSql(call: unknown[] | undefined): string {
  const strings = call?.[0];
  const raw =
    strings && typeof strings === 'object' && 'raw' in strings
      ? (strings.raw as readonly string[])
      : [];
  return raw.join('?').replace(/\s+/g, ' ').trim();
}

function previewFlagWrite() {
  return db.executeRaw.mock.calls.find((call) => rawSql(call).includes('previewingCheckpointId'));
}

beforeEach(() => {
  vi.clearAllMocks();
  actor.peek.mockReturnValue(OWNER);
  db.projectFindFirst.mockResolvedValue({ id: PROJECT, ownerId: OWNER.id });
  db.checkpointFindFirst.mockResolvedValue(CHECKPOINT_ROW);
  db.checkpointFindMany.mockResolvedValue([]);
  db.checkpointCreate.mockResolvedValue({ ...CHECKPOINT_ROW, id: 'cp-new' });
  db.checkpointUpdate.mockResolvedValue({ ...CHECKPOINT_ROW, id: 'cp-new' });
  db.checkpointFindUniqueOrThrow.mockResolvedValue({ ...CHECKPOINT_ROW, id: 'cp-new' });
  db.projectUpdate.mockResolvedValue(undefined);
  db.executeRaw.mockResolvedValue(1);
  db.queryRaw.mockResolvedValue([{ previewingCheckpointId: null }]);
  snapshot.readSnapshot.mockResolvedValue(OLD_FILES);
  snapshot.captureFileSnapshot.mockResolvedValue(OLD_FILES);
  lock.withProjectLock.mockImplementation(
    async (_id: string, _userId: string, _reason: string, run: () => unknown) => ({
      ok: true as const,
      value: await run(),
    }),
  );
});

describe('previewing a version leaves the live project alone', () => {
  it('writes no lastCode', async () => {
    const { previewCheckpoint } = await import('@/lib/checkpoints/actions');

    const result = await previewCheckpoint(PROJECT, CHECKPOINT);

    expect(result.ok).toBe(true);
    // The whole finding in one assertion: previewing is a read, so nothing may be
    // written to the row the site is served, published and exported from.
    const lastCodeWrites = db.projectUpdate.mock.calls.filter((call) => {
      const args = call[0];
      if (!args || typeof args !== 'object' || !('data' in args)) return false;
      const data = args.data;
      return Boolean(data && typeof data === 'object' && 'lastCode' in data);
    });
    expect(lastCodeWrites).toEqual([]);
  });

  it('records which version is being previewed on the project row', async () => {
    const { previewCheckpoint } = await import('@/lib/checkpoints/actions');

    await previewCheckpoint(PROJECT, CHECKPOINT);

    const write = previewFlagWrite();
    expect(write).toBeDefined();
    expect(rawSql(write)).toMatch(/^UPDATE "Project"/);
    expect(write?.slice(1)).toEqual([CHECKPOINT, PROJECT]);
  });

  it('refuses the preview when the snapshot cannot be read, and marks nothing', async () => {
    snapshot.readSnapshot.mockRejectedValue(new FakeSnapshotReadError('S3 down'));
    const { previewCheckpoint } = await import('@/lib/checkpoints/actions');

    const result = await previewCheckpoint(PROJECT, CHECKPOINT);

    expect(result).toMatchObject({ ok: false, status: 503 });
    expect(previewFlagWrite()).toBeUndefined();
  });

  it('reports a project that vanished under the write instead of claiming success', async () => {
    db.executeRaw.mockResolvedValue(0);
    const { previewCheckpoint } = await import('@/lib/checkpoints/actions');

    const result = await previewCheckpoint(PROJECT, CHECKPOINT);

    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it('names a missing migration instead of leaking a Postgres error', async () => {
    // The application database can legitimately be behind the committed migrations. That is an
    // operator problem with a specific answer, not a 500 and not a success.
    db.executeRaw.mockRejectedValue(
      Object.assign(
        new Error('column "previewingCheckpointId" of relation "Project" does not exist'),
        {
          code: '42703',
        },
      ),
    );
    const { previewCheckpoint } = await import('@/lib/checkpoints/actions');

    const result = await previewCheckpoint(PROJECT, CHECKPOINT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(503);
    expect(result.error).toMatch(/database update/i);
  });

  it('an unrelated database error is still an error, not a missing migration', async () => {
    db.executeRaw.mockRejectedValue(new Error('connection terminated unexpectedly'));
    const { previewCheckpoint } = await import('@/lib/checkpoints/actions');

    await expect(previewCheckpoint(PROJECT, CHECKPOINT)).rejects.toThrow(/connection terminated/);
  });
});

describe('the previewing flag survives a reload', () => {
  it('getCheckpoints reports which version is being previewed', async () => {
    db.queryRaw.mockResolvedValue([{ previewingCheckpointId: CHECKPOINT }]);
    const { getCheckpoints } = await import('@/lib/checkpoints/actions');

    const result = await getCheckpoints(PROJECT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Nothing else can tell a freshly loaded page that it is looking at an old version.
    expect(result.previewingCheckpointId).toBe(CHECKPOINT);
  });

  it('reports null when the project is on its current version', async () => {
    const { getCheckpoints } = await import('@/lib/checkpoints/actions');

    const result = await getCheckpoints(PROJECT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.previewingCheckpointId).toBeNull();
  });
});

describe('leaving the preview clears the flag and writes no files', () => {
  it('exitCheckpointPreview clears previewingCheckpointId only', async () => {
    const { exitCheckpointPreview } = await import('@/lib/checkpoints/actions');

    const result = await exitCheckpointPreview(PROJECT);

    expect(result.ok).toBe(true);
    expect(db.projectUpdate).not.toHaveBeenCalled();
    const clear = previewFlagWrite();
    expect(rawSql(clear)).toContain('NULL');
    expect(clear?.slice(1)).toEqual([PROJECT]);
  });

  it('restoreCheckpoint leaves no preview flag behind', async () => {
    const { restoreCheckpoint } = await import('@/lib/checkpoints/actions');

    const result = await restoreCheckpoint(PROJECT, CHECKPOINT);

    expect(result.ok).toBe(true);
    const clear = previewFlagWrite();
    expect(clear).toBeDefined();
    expect(rawSql(clear)).toContain('NULL');
  });
});

describe('the read path is what shows the old version', () => {
  it('serves the checkpoint snapshot while a preview is on, and names the version', async () => {
    db.queryRaw.mockResolvedValue([{ previewingCheckpointId: CHECKPOINT }]);
    const { servedProjectFiles } = await import('@/lib/checkpoints/served-files');

    const result = await servedProjectFiles({ id: PROJECT, lastCode: LIVE_LAST_CODE });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files['src/App.jsx']).toBe('<h1>v1</h1>');
    expect(result.previewing).toMatchObject({ checkpointId: CHECKPOINT, label: 'First build' });
  });

  it('serves the live files when no preview is on', async () => {
    const { servedProjectFiles } = await import('@/lib/checkpoints/served-files');

    const result = await servedProjectFiles({ id: PROJECT, lastCode: LIVE_LAST_CODE });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files['src/App.jsx']).toBe('<h1>v9 — the live site</h1>');
    expect(result.previewing).toBeNull();
  });

  it('says storage failed rather than quietly serving the live files', async () => {
    db.queryRaw.mockResolvedValue([{ previewingCheckpointId: CHECKPOINT }]);
    snapshot.readSnapshot.mockRejectedValue(new FakeSnapshotReadError('S3 down'));
    const { servedProjectFiles } = await import('@/lib/checkpoints/served-files');

    const result = await servedProjectFiles({ id: PROJECT, lastCode: LIVE_LAST_CODE });

    expect(result).toMatchObject({ ok: false, status: 503 });
  });

  it('says the previewed version is gone rather than quietly serving the live files', async () => {
    db.queryRaw.mockResolvedValue([{ previewingCheckpointId: CHECKPOINT }]);
    db.checkpointFindFirst.mockResolvedValue(null);
    const { servedProjectFiles } = await import('@/lib/checkpoints/served-files');

    const result = await servedProjectFiles({ id: PROJECT, lastCode: LIVE_LAST_CODE });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.error).toMatch(/current version/i);
  });
});
