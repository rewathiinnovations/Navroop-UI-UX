import { beforeEach, describe, expect, it, vi } from 'vitest';
import { keepPartialBuild } from '@/lib/jobs/recovery';
import { getCurrentProjectFiles } from '@/lib/github/current-files';

/**
 * F-020: "Keep what was built" on a failed edit must merge, never replace.
 *
 * `keepPartialBuild` wrote `lastCode: filesToLastCode(files)` where `files` was only
 * `Job.partialFiles` — the files *this* run streamed. On a FOLLOWUP that is a fraction
 * of the site: a 30-file project whose failed edit streamed one file became a 1-file
 * project, and a checkpoint of the damaged tree was written immediately afterwards, so
 * the newest snapshot was the destruction. The settle path already does the right thing
 * ("Merge over what is already there, never replace it" — settle-generation.ts); this
 * pins the keep path to the same contract, plus the two side effects the replacing
 * write skipped: `bumpContentVersion` (other tabs must learn the content moved) and
 * the raw `NEED_IMAGE:` sweep (a kept build must not ship literal tokens).
 */

const prisma = vi.hoisted(() => ({
  project: {
    update: vi.fn(),
    findUnique: vi.fn(),
  },
  projectPlan: { updateMany: vi.fn() },
}));
const store = vi.hoisted(() => ({
  claimKeptPartialJob: vi.fn(),
  getActiveJob: vi.fn(),
  getJob: vi.fn(),
  getLatestJob: vi.fn(),
  releaseKeptPartialClaim: vi.fn(),
  setProjectResumablePhase: vi.fn(),
  settleKeptPartialJob: vi.fn(),
}));
const lifecycle = vi.hoisted(() => ({
  cancelJob: vi.fn(),
  createOrReuseJob: vi.fn(),
  resolveResumablePhase: vi.fn(),
}));
const checkpoints = vi.hoisted(() => ({ createCheckpoint: vi.fn() }));
const lock = vi.hoisted(() => ({ bumpContentVersion: vi.fn() }));

vi.mock('@/lib/db', () => ({ prisma }));
vi.mock('@/lib/checkpoints/actions', () => ({ createCheckpoint: checkpoints.createCheckpoint }));
vi.mock('@/lib/projects/plan', () => ({ getApprovedPlanGenerationContext: vi.fn() }));
vi.mock('@/lib/projects/lock', () => ({ bumpContentVersion: lock.bumpContentVersion }));
vi.mock('@/lib/jobs/lifecycle', () => ({
  cancelJob: lifecycle.cancelJob,
  createOrReuseJob: lifecycle.createOrReuseJob,
  resolveResumablePhase: lifecycle.resolveResumablePhase,
}));
vi.mock('@/lib/jobs/store', () => ({
  claimKeptPartialJob: store.claimKeptPartialJob,
  getActiveJob: store.getActiveJob,
  getJob: store.getJob,
  getLatestJob: store.getLatestJob,
  releaseKeptPartialClaim: store.releaseKeptPartialClaim,
  setProjectResumablePhase: store.setProjectResumablePhase,
  settleKeptPartialJob: store.settleKeptPartialJob,
}));

const BASE_FILES: Record<string, string> = {
  'app/page.tsx': '<main>home</main>',
  'app/about/page.tsx': '<main>about</main>',
  'lib/site.ts': "export const site = { name: 'Acme' };",
};

const BASE_LAST_CODE = Object.entries(BASE_FILES)
  .map(([path, content]) => `<file path="${path}">\n${content}\n</file>`)
  .join('\n\n');

const EDIT_PARTIALS = [
  { path: 'app/page.tsx', content: '<main>new home</main>' },
  { path: 'app/contact/page.tsx', content: '<main>contact</main>' },
];

const JOB = {
  id: 'job-1',
  projectId: 'proj-1',
  userId: 'user-1',
  workspaceId: 'ws-1',
  kind: 'FOLLOWUP' as const,
  status: 'ABANDONED' as const,
  attempt: 1,
  maxAttempts: 2,
  filesWritten: 2,
  partialFiles: EDIT_PARTIALS,
  inputPrompt: 'add a contact page',
  planVersion: 1,
  lastStep: 'writing_files',
  errorCode: 'client_disconnected',
  creditsChargedAt: new Date('2026-08-19T00:00:00.000Z'),
};

function storedFiles(): Record<string, string> {
  const call = prisma.project.update.mock.calls[0]?.[0];
  return getCurrentProjectFiles({ lastCode: call?.data?.lastCode ?? null });
}

beforeEach(() => {
  vi.clearAllMocks();
  store.claimKeptPartialJob.mockResolvedValue(true);
  store.settleKeptPartialJob.mockResolvedValue(true);
});

describe('keepPartialBuild merges over the current site (F-020)', () => {
  it('keeps every base file and overlays only what the failed edit streamed', async () => {
    store.getJob.mockResolvedValue(JOB);
    prisma.project.findUnique.mockResolvedValue({ lastCode: BASE_LAST_CODE });

    const result = await keepPartialBuild('job-1');

    expect(result).toMatchObject({ ok: true, filesWritten: 2 });
    const files = storedFiles();
    // All 3 base files survive, with the 2 partials overlaid — 4 files, not 2.
    expect(Object.keys(files).sort()).toEqual([
      'app/about/page.tsx',
      'app/contact/page.tsx',
      'app/page.tsx',
      'lib/site.ts',
    ]);
    expect(files['app/page.tsx']).toBe('<main>new home</main>');
    expect(files['app/about/page.tsx']).toBe(BASE_FILES['app/about/page.tsx']);
    expect(files['lib/site.ts']).toBe(BASE_FILES['lib/site.ts']);
    // The checkpoint snapshots the merged tree, after the write.
    expect(checkpoints.createCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('tells other tabs the content moved, like the normal persist path', async () => {
    store.getJob.mockResolvedValue(JOB);
    prisma.project.findUnique.mockResolvedValue({ lastCode: BASE_LAST_CODE });

    await keepPartialBuild('job-1');

    expect(lock.bumpContentVersion).toHaveBeenCalledWith('proj-1');
  });

  it('a first build with no base keeps the partial files as the whole tree', async () => {
    store.getJob.mockResolvedValue({ ...JOB, kind: 'BUILD' as const });
    prisma.project.findUnique.mockResolvedValue({ lastCode: null });

    const result = await keepPartialBuild('job-1');

    expect(result).toMatchObject({ ok: true, filesWritten: 2 });
    expect(Object.keys(storedFiles()).sort()).toEqual(['app/contact/page.tsx', 'app/page.tsx']);
    expect(checkpoints.createCheckpoint).toHaveBeenCalledTimes(1);
    expect(lock.bumpContentVersion).toHaveBeenCalledWith('proj-1');
  });

  it('does not checkpoint or bump when the partials change nothing', async () => {
    store.getJob.mockResolvedValue({
      ...JOB,
      filesWritten: 1,
      partialFiles: [{ path: 'app/page.tsx', content: BASE_FILES['app/page.tsx'] }],
    });
    prisma.project.findUnique.mockResolvedValue({ lastCode: BASE_LAST_CODE });

    const result = await keepPartialBuild('job-1');

    // The job still settles — the click must land somewhere — but a tree identical
    // to the base earns no duplicate checkpoint and no version bump.
    expect(result).toMatchObject({ ok: true });
    expect(store.settleKeptPartialJob).toHaveBeenCalledWith('job-1');
    expect(checkpoints.createCheckpoint).not.toHaveBeenCalled();
    expect(lock.bumpContentVersion).not.toHaveBeenCalled();
  });

  it('sweeps raw NEED_IMAGE tokens out of kept files', async () => {
    store.getJob.mockResolvedValue({
      ...JOB,
      filesWritten: 1,
      partialFiles: [
        { path: 'app/page.tsx', content: '<img src="NEED_IMAGE: bakery hero | 16:9" />' },
      ],
    });
    prisma.project.findUnique.mockResolvedValue({ lastCode: BASE_LAST_CODE });

    await keepPartialBuild('job-1');

    expect(storedFiles()['app/page.tsx']).not.toContain('NEED_IMAGE:');
  });

  it('hands the claim back when loading the base tree fails', async () => {
    store.getJob.mockResolvedValue(JOB);
    prisma.project.findUnique.mockRejectedValue(new Error('db down'));

    await expect(keepPartialBuild('job-1')).rejects.toThrow(/db down/);

    // A failed read must not settle the job or leave the claim held.
    expect(store.settleKeptPartialJob).not.toHaveBeenCalled();
    expect(store.releaseKeptPartialClaim).toHaveBeenCalledWith('job-1', 'writing_files');
    expect(prisma.project.update).not.toHaveBeenCalled();
  });
});
