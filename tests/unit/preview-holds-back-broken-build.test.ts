import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The preview must not show a version the validators said does not build.
 *
 * The auto-fix loop runs *because* validation failed, and every pass it spends is written
 * straight into `Project.lastCode` — the map the workspace compiles in the browser. So on an
 * edit to a working site, asking for a change used to take the working site away and put a
 * broken one in its place for the length of the loop, and longer if the loop gave up.
 *
 * The read path now declines. What is pinned here is mostly what it refuses to do: the
 * hold-back needs positive evidence on *both* sides — the current files known broken and an
 * earlier snapshot known good — and anything short of that serves the live files exactly as
 * before. Three states, not two: `null` is "nobody checked", which is what every row written
 * before the column existed carries, and reading it as either verdict would be wrong for a
 * large number of real projects.
 *
 * Modules under test are pulled in with `await import` because a static import would bind
 * before `vi.mock` registers — the same reason the sibling checkpoint suites do it.
 */

const db = vi.hoisted(() => ({
  checkpointFindFirst: vi.fn(),
  queryRaw: vi.fn(),
}));
const snapshot = vi.hoisted(() => ({ readSnapshot: vi.fn() }));

vi.mock('@/lib/db', () => ({
  prisma: {
    checkpoint: { findFirst: db.checkpointFindFirst },
    $queryRaw: db.queryRaw,
  },
}));

/** No object storage in a unit test. A class because the code branches on `instanceof`. */
class FakeSnapshotReadError extends Error {}

vi.mock('@/lib/checkpoints/snapshot', () => ({
  readSnapshot: snapshot.readSnapshot,
  SnapshotReadError: FakeSnapshotReadError,
}));

const PROJECT = 'p-heldback';
const GOOD = 'cp-good';

const LIVE_LAST_CODE = JSON.stringify({ 'src/App.jsx': '<h1>the broken repair pass</h1>' });
const GOOD_FILES = [{ path: 'src/App.jsx', content: '<h1>the last version that built</h1>' }];

const GOOD_ROW = {
  id: GOOD,
  label: 'Add a pricing page',
  createdAt: new Date('2026-08-29T02:00:00.000Z'),
  snapshotPruned: false,
  snapshotKey: `snapshots/${PROJECT}/${GOOD}.json.gz`,
  fileSnapshot: null,
};

async function serve(lastCodeValidated: boolean | null | undefined) {
  const { servedProjectFiles } = await import('@/lib/checkpoints/served-files');
  return servedProjectFiles({ id: PROJECT, lastCode: LIVE_LAST_CODE, lastCodeValidated });
}

beforeEach(() => {
  vi.clearAllMocks();
  // No preview in effect unless a test says otherwise.
  db.queryRaw.mockResolvedValue([{ previewingCheckpointId: null }]);
  db.checkpointFindFirst.mockResolvedValue(GOOD_ROW);
  snapshot.readSnapshot.mockResolvedValue(GOOD_FILES);
});

describe('a build known to fail is not what the preview compiles', () => {
  it('serves the last snapshot proven good, and names it so the swap is visible', async () => {
    const result = await serve(false);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files['src/App.jsx']).toBe('<h1>the last version that built</h1>');
    expect(result.heldBack).toMatchObject({ checkpointId: GOOD, label: 'Add a pricing page' });
    // Not a preview. The two banners say different things and the reader is in a different
    // situation — one they chose, one the product chose for them.
    expect(result.previewing).toBeNull();
  });

  it('asks only for snapshots recorded as good, newest first', async () => {
    await serve(false);

    const where = db.checkpointFindFirst.mock.calls[0]?.[0]?.where;
    expect(where).toMatchObject({ projectId: PROJECT, snapshotValidated: true });
    // A thinned checkpoint has no snapshot to serve, so it is not a candidate.
    expect(where.snapshotPruned).toBe(false);
    expect(db.checkpointFindFirst.mock.calls[0]?.[0]?.orderBy).toEqual({ createdAt: 'desc' });
  });
});

describe('without evidence on both sides, nothing changes', () => {
  it('leaves an unchecked project alone — null is not a failure', async () => {
    const result = await serve(null);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files['src/App.jsx']).toBe('<h1>the broken repair pass</h1>');
    expect(result.heldBack).toBeNull();
    // The cost matters as much as the answer: this is a file read, and it must not query the
    // history of every project that predates the column.
    expect(db.checkpointFindFirst).not.toHaveBeenCalled();
  });

  it('leaves a passing project alone', async () => {
    const result = await serve(true);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files['src/App.jsx']).toBe('<h1>the broken repair pass</h1>');
    expect(result.heldBack).toBeNull();
    expect(db.checkpointFindFirst).not.toHaveBeenCalled();
  });

  it('serves the broken files when there is no proven-good version to fall back to', async () => {
    db.checkpointFindFirst.mockResolvedValue(null);

    const result = await serve(false);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A first build that failed has nothing behind it. Showing the user's own broken site is
    // the honest outcome; a hold-back that cannot name what it holds back to is a blank pane.
    expect(result.files['src/App.jsx']).toBe('<h1>the broken repair pass</h1>');
    expect(result.heldBack).toBeNull();
  });

  it('falls through to the live files when the good snapshot cannot be read', async () => {
    snapshot.readSnapshot.mockRejectedValue(new FakeSnapshotReadError('storage down'));

    const result = await serve(false);

    // Unlike a preview, nobody asked to see this version — so a storage failure is not an
    // error the reader has to act on. It is logged and the live files are served, which is
    // what the project actually holds.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files['src/App.jsx']).toBe('<h1>the broken repair pass</h1>');
    expect(result.heldBack).toBeNull();
  });

  it('falls through when the good snapshot reads back empty', async () => {
    snapshot.readSnapshot.mockResolvedValue([]);

    const result = await serve(false);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files['src/App.jsx']).toBe('<h1>the broken repair pass</h1>');
    expect(result.heldBack).toBeNull();
  });
});

describe('a version the reader chose outranks one the product chose', () => {
  it('serves the previewed checkpoint even while the current build is broken', async () => {
    db.queryRaw.mockResolvedValue([{ previewingCheckpointId: 'cp-chosen' }]);
    db.checkpointFindFirst.mockResolvedValue({
      ...GOOD_ROW,
      id: 'cp-chosen',
      label: 'First build',
    });
    snapshot.readSnapshot.mockResolvedValue([{ path: 'src/App.jsx', content: '<h1>v1</h1>' }]);

    const result = await serve(false);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The reader is looking at a banner that names this version and offers a way out of it.
    // Substituting a different one underneath that banner would make it a lie.
    expect(result.files['src/App.jsx']).toBe('<h1>v1</h1>');
    expect(result.previewing).toMatchObject({ checkpointId: 'cp-chosen' });
    expect(result.heldBack).toBeNull();
  });
});
