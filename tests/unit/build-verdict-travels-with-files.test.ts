import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The build verdict is a claim about specific bytes, so it moves with them.
 *
 * Everything downstream — the preview declining to compile a failed repair pass, the Publish
 * button refusing a site that does not build, the rescue picking a version to fall back to —
 * reads `Project.lastCodeValidated` and `Checkpoint.snapshotValidated` and acts on them. A
 * verdict that outlives the code it was about is therefore worse than no verdict: a stale
 * `false` hides a working site behind an older one, and a stale `true` publishes a broken one.
 *
 * These tests are about the plumbing rather than the checkers. Each one pins one hop:
 * validator to project row, project row to snapshot, snapshot back to project row on a
 * restore. The hop that is missing is the bug, and it is invisible from either end.
 */

const db = vi.hoisted(() => ({
  projectUpdateMany: vi.fn(),
  projectFindUnique: vi.fn(),
  projectFindFirst: vi.fn(),
  projectUpdate: vi.fn(),
  checkpointFindFirst: vi.fn(),
  checkpointFindMany: vi.fn(),
  checkpointCreate: vi.fn(),
  checkpointUpdate: vi.fn(),
  checkpointFindUniqueOrThrow: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    project: {
      updateMany: db.projectUpdateMany,
      findUnique: db.projectFindUnique,
      findFirst: db.projectFindFirst,
      update: db.projectUpdate,
    },
    checkpoint: {
      findFirst: db.checkpointFindFirst,
      findMany: db.checkpointFindMany,
      create: db.checkpointCreate,
      update: db.checkpointUpdate,
      findUniqueOrThrow: db.checkpointFindUniqueOrThrow,
    },
  },
}));

const { siteValidatedFromBuild } = await import('@/lib/validation/run-build-validation');
const { writeMergedSite } = await import('@/lib/jobs/settle-generation');

function outcome(status: 'passed' | 'failed' | 'skipped') {
  return {
    result: { status, stack: 'NEXTJS' as const, errors: [], missingPackages: [], signature: null },
    decision: { action: 'none' as const },
    retry: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.projectUpdateMany.mockResolvedValue({ count: 1 });
});

describe('what the validators said becomes what is stored', () => {
  it('records a pass as a pass and a failure as a failure', () => {
    expect(siteValidatedFromBuild(outcome('passed'))).toBe(true);
    expect(siteValidatedFromBuild(outcome('failed'))).toBe(false);
  });

  it('records a skipped check as no answer, not as a pass', () => {
    // The mistake this whole area keeps relearning. A stack with no module graph and an empty
    // file set both end in `skipped`, and neither is evidence that anything works — so the
    // hold-back and the publish gate must both decline to act on them.
    expect(siteValidatedFromBuild(outcome('skipped'))).toBeNull();
  });

  it('records no validation at all as no answer', () => {
    expect(siteValidatedFromBuild(null)).toBeNull();
  });
});

describe('the verdict lands in the same statement as the files', () => {
  it('writes the failure beside the code it is about', async () => {
    await writeMergedSite(
      'p1',
      { 'app/page.tsx': 'export default () => null;' },
      { lastCode: null, contentVersion: 3 },
      [],
      'merge',
      false,
    );

    const call = db.projectUpdateMany.mock.calls[0]?.[0];
    expect(call.data.lastCodeValidated).toBe(false);
    // The compare-and-set is the point: a follow-up UPDATE could land after another writer
    // had already replaced the site, leaving the row carrying a verdict about code it no
    // longer holds — which the read paths would then trust.
    expect(call.where).toMatchObject({ id: 'p1', contentVersion: 3 });
    expect(call.data.lastCode).toContain('app/page.tsx');
  });

  it('clears the verdict for a writer that did not check anything', async () => {
    // The default, which is what an import and a kept partial get. Not "leave it alone":
    // whatever the row said was about the files this write is replacing.
    await writeMergedSite('p1', { 'app/page.tsx': 'x' }, { lastCode: null, contentVersion: 0 });

    expect(db.projectUpdateMany.mock.calls[0]?.[0]?.data?.lastCodeValidated).toBeNull();
  });

  it('carries the verdict onto the base that actually won a lost race', async () => {
    db.projectUpdateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    db.projectFindUnique.mockResolvedValue({ lastCode: null, contentVersion: 9 });

    await writeMergedSite(
      'p1',
      { 'app/page.tsx': 'x' },
      { lastCode: null, contentVersion: 3 },
      [],
      'merge',
      true,
    );

    // A re-merge must not quietly drop the verdict on its way round the loop.
    const retry = db.projectUpdateMany.mock.calls[1]?.[0];
    expect(retry.where).toMatchObject({ contentVersion: 9 });
    expect(retry.data.lastCodeValidated).toBe(true);
  });
});
