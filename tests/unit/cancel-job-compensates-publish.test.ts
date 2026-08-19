import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelJob } from '@/lib/jobs/lifecycle';

/**
 * Cancelling a publish has to undo the publish.
 *
 * `abandonActiveJob` and `failJob` both split on `isGenerationKind` and compensate a
 * PUBLISH; `cancelJob` did neither. So a cancelled publish left its half-created Coolify
 * app, DNS record and GitHub repo alive with nothing pointing at them — waiting on the
 * orphan cron to guess they were rubbish — and rewrote the project's phase and
 * generationStatus as if a generation had ended.
 */

const prisma = vi.hoisted(() => ({
  workspace: { upsert: vi.fn() },
  project: { findUnique: vi.fn() },
  checkpoint: { count: vi.fn() },
  projectPlan: { findFirst: vi.fn() },
  $executeRaw: vi.fn(),
}));
const store = vi.hoisted(() => ({
  getJob: vi.fn(),
  updateJobIfActive: vi.fn(),
  setProjectActiveJob: vi.fn(),
  setProjectResumablePhase: vi.fn(),
}));
const publish = vi.hoisted(() => ({ compensateAbandonedPublish: vi.fn() }));

vi.mock('@/lib/db', () => ({ prisma }));
vi.mock('@/lib/projects/lock', () => ({ acquireLock: vi.fn(), releaseLock: vi.fn() }));
vi.mock('@/lib/plans/limits', () => ({ consumeCredits: vi.fn() }));
vi.mock('@/lib/jobs/compensate-publish', () => ({
  compensateAbandonedPublish: publish.compensateAbandonedPublish,
}));
vi.mock('@/lib/jobs/store', () => ({
  claimJobCreditCharge: vi.fn(),
  findJobByIdempotency: vi.fn(),
  getActiveJob: vi.fn(),
  getJob: store.getJob,
  insertJobRaw: vi.fn(),
  listLegacyStuckProjects: vi.fn(),
  listReconcileCandidates: vi.fn(),
  listTimeoutCandidates: vi.fn(),
  releaseJobCreditCharge: vi.fn(),
  setProjectActiveJob: store.setProjectActiveJob,
  setProjectResumablePhase: store.setProjectResumablePhase,
  updateJobFields: vi.fn(),
  updateJobIfActive: store.updateJobIfActive,
}));

const JOB = {
  id: 'job-1',
  projectId: 'proj-1',
  userId: 'user-1',
  workspaceId: 'ws-1',
  kind: 'PUBLISH' as const,
  status: 'RUNNING' as const,
  filesWritten: 0,
  lastStep: 'deploy',
};

describe('cancelJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.project.findUnique.mockResolvedValue({ lastCode: null });
    prisma.checkpoint.count.mockResolvedValue(0);
    prisma.projectPlan.findFirst.mockResolvedValue(null);
    store.updateJobIfActive.mockImplementation(
      async (_id: string, fields: { status?: string }) => ({
        ...JOB,
        status: fields.status ?? JOB.status,
      }),
    );
  });

  it('compensates a cancelled publish and leaves the project phase alone', async () => {
    store.getJob.mockResolvedValue(JOB);

    await cancelJob('job-1');

    expect(publish.compensateAbandonedPublish).toHaveBeenCalledWith('job-1');
    // A publish is not a generation: clear the active job, do not rewrite the phase.
    expect(store.setProjectActiveJob).toHaveBeenCalledWith('proj-1', null);
    expect(store.setProjectResumablePhase).not.toHaveBeenCalled();
  });

  it('resumes the project phase for a cancelled generation and compensates nothing', async () => {
    store.getJob.mockResolvedValue({ ...JOB, kind: 'BUILD', filesWritten: 2 });

    await cancelJob('job-1');

    expect(publish.compensateAbandonedPublish).not.toHaveBeenCalled();
    expect(store.setProjectResumablePhase).toHaveBeenCalledWith(
      'proj-1',
      expect.any(String),
      'idle',
    );
  });
});
