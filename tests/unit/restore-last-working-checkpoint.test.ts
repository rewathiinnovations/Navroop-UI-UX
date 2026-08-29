import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The rescue that runs when the auto-fix loop gives up, and the two ways it must not fire.
 *
 * The repair loop starts *because* validation failed and stops the moment a pass validates,
 * so there is never a good intermediate inside it. When it exhausts its attempts the project
 * is left holding the last broken attempt — which, on an edit to a site that was working, is
 * worse than what the person had before they typed anything: two billed repairs and a more
 * broken site.
 *
 * The behaviour is deliberately narrow, and the narrowness is the point. It does not chase
 * the "best" version by score: a page with fewer advisory findings is not worth silently
 * rewriting someone's project for. It only ever trades a broken site for one it has proven
 * still builds — and when it cannot prove that, it does nothing and says so.
 */

const findMany = vi.fn();
const findFirst = vi.fn();
const readSnapshot = vi.fn();
const checkGeneratedImports = vi.fn();
const checkBuild = vi.fn();
const typecheckGenerated = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    project: { findFirst: (...args: unknown[]) => findFirst(...args) },
    checkpoint: { findMany: (...args: unknown[]) => findMany(...args) },
  },
}));
vi.mock('@/lib/checkpoints/snapshot', () => ({
  readSnapshot: (...args: unknown[]) => readSnapshot(...args),
}));
vi.mock('@/lib/validation/import-check', () => ({
  checkGeneratedImports: (...args: unknown[]) => checkGeneratedImports(...args),
}));
vi.mock('@/lib/validation/build-check', () => ({
  checkBuild: (...args: unknown[]) => checkBuild(...args),
}));
vi.mock('@/lib/validation/typecheck', () => ({
  typecheckGenerated: (...args: unknown[]) => typecheckGenerated(...args),
}));

const { findLastWorkingCheckpoint } = await import('@/lib/checkpoints/restore-working');

const checkpoint = (id: string, label = id) => ({
  id,
  label,
  createdAt: new Date(),
  snapshotKey: `k/${id}`,
  fileSnapshot: null,
});

function passing() {
  checkGeneratedImports.mockReturnValue({ result: { status: 'passed' } });
  checkBuild.mockResolvedValue({ status: 'passed' });
  typecheckGenerated.mockReturnValue({ status: 'passed' });
}

beforeEach(() => {
  vi.clearAllMocks();
  findFirst.mockResolvedValue({ stack: 'NEXTJS', designDirection: 'minimal' });
  readSnapshot.mockResolvedValue([{ path: 'app/page.tsx', content: 'export default () => null;' }]);
  passing();
});

describe('what it restores to', () => {
  it('picks the most recent version it can prove still builds', async () => {
    findMany.mockResolvedValue([checkpoint('c3', 'Latest'), checkpoint('c2'), checkpoint('c1')]);

    const found = await findLastWorkingCheckpoint('p1');

    expect(found).toMatchObject({ found: true, checkpointId: 'c3', label: 'Latest' });
    // Proven, not remembered: a stored "this one was good" flag is written once and read much
    // later, and nothing keeps it true in between.
    expect(checkBuild).toHaveBeenCalledTimes(1);
  });

  it('walks back past a candidate that does not build', async () => {
    findMany.mockResolvedValue([checkpoint('c3'), checkpoint('c2'), checkpoint('c1')]);
    checkBuild
      .mockResolvedValueOnce({ status: 'failed' })
      .mockResolvedValueOnce({ status: 'passed' });

    expect(await findLastWorkingCheckpoint('p1')).toMatchObject({
      found: true,
      checkpointId: 'c2',
    });
  });

  it('walks back past one that builds but does not type-check', async () => {
    findMany.mockResolvedValue([checkpoint('c3'), checkpoint('c2')]);
    typecheckGenerated
      .mockReturnValueOnce({ status: 'failed' })
      .mockReturnValueOnce({ status: 'passed' });

    expect(await findLastWorkingCheckpoint('p1')).toMatchObject({
      found: true,
      checkpointId: 'c2',
    });
  });

  it('skips the current state when told to, so it cannot restore the broken files to themselves', async () => {
    findMany.mockResolvedValue([checkpoint('c2')]);

    await findLastWorkingCheckpoint('p1', { skipCheckpointId: 'c3' });

    expect(findMany.mock.calls[0][0].where.id).toEqual({ not: 'c3' });
  });
});

describe('when it does nothing at all', () => {
  it('reports none-validated rather than restoring a candidate it could not check', async () => {
    findMany.mockResolvedValue([checkpoint('c2')]);
    // `skipped` is not `passed`. A candidate nothing could check is not evidence of anything,
    // and restoring on it would be guessing with someone else's project.
    checkBuild.mockResolvedValue({ status: 'skipped' });

    expect(await findLastWorkingCheckpoint('p1')).toEqual({
      found: false,
      reason: 'none-validated',
    });
  });

  it('reports no-candidates on a first build, where there is nothing to go back to', async () => {
    findMany.mockResolvedValue([]);
    expect(await findLastWorkingCheckpoint('p1')).toEqual({
      found: false,
      reason: 'no-candidates',
    });
  });

  it('refuses STATIC_HTML, where "does it build" is not a question these checks answer', async () => {
    findFirst.mockResolvedValue({ stack: 'STATIC_HTML', designDirection: null });

    expect(await findLastWorkingCheckpoint('p1')).toEqual({
      found: false,
      reason: 'no-candidates',
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('treats a crashing checker as "cannot say", never as a pass', async () => {
    findMany.mockResolvedValue([checkpoint('c2')]);
    checkBuild.mockRejectedValue(new Error('bundler is down'));

    expect(await findLastWorkingCheckpoint('p1')).toMatchObject({ found: false });
  });

  it('skips a pruned snapshot that reads back empty', async () => {
    findMany.mockResolvedValue([checkpoint('c3'), checkpoint('c2')]);
    readSnapshot.mockResolvedValueOnce([]);

    expect(await findLastWorkingCheckpoint('p1')).toMatchObject({
      found: true,
      checkpointId: 'c2',
    });
  });

  it('only ever asks the database for unpruned checkpoints, newest first', async () => {
    findMany.mockResolvedValue([]);
    await findLastWorkingCheckpoint('p1');

    const query = findMany.mock.calls[0][0];
    expect(query.where.snapshotPruned).toBe(false);
    expect(query.orderBy).toEqual({ createdAt: 'desc' });
    // Bounded: beyond a few versions back, silently restoring is its own surprise.
    expect(query.take).toBeLessThanOrEqual(3);
  });
});
