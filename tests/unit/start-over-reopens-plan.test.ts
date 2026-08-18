import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "Start over" after a failed first build resets the project to PLANNING —
 * but the plan it rolled back to was still APPROVED, and an APPROVED plan
 * renders no Approve button. The user was told to "review the plan and
 * approve" with nothing to click. Start over must reopen the plan.
 */

const prisma = vi.hoisted(() => ({
  projectPlan: { updateMany: vi.fn() },
}));
const lifecycle = vi.hoisted(() => ({
  cancelJob: vi.fn(),
  resolveResumablePhase: vi.fn(),
}));
const store = vi.hoisted(() => ({
  getJob: vi.fn(),
  getLatestJob: vi.fn(),
  setProjectResumablePhase: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ prisma }));
// recovery.ts's siblings pull next-auth through @/lib/auth — irrelevant here.
vi.mock('@/lib/checkpoints/actions', () => ({ createCheckpoint: vi.fn() }));
vi.mock('@/lib/projects/plan', () => ({ getApprovedPlanGenerationContext: vi.fn() }));
vi.mock('@/lib/jobs/lifecycle', () => ({
  cancelJob: lifecycle.cancelJob,
  resolveResumablePhase: lifecycle.resolveResumablePhase,
  createOrReuseJob: vi.fn(),
}));
vi.mock('@/lib/jobs/store', () => ({
  getJob: store.getJob,
  getLatestJob: store.getLatestJob,
  setProjectResumablePhase: store.setProjectResumablePhase,
  insertJobRaw: vi.fn(),
  updateJobFields: vi.fn(),
}));

describe('startOverJob', () => {
  beforeEach(() => {
    prisma.projectPlan.updateMany.mockReset();
    lifecycle.cancelJob.mockReset();
    lifecycle.resolveResumablePhase.mockReset();
    store.getJob.mockReset();
    store.setProjectResumablePhase.mockReset();
    store.getJob.mockResolvedValue({ id: 'job-1', projectId: 'proj-1' });
  });

  it('reopens an APPROVED plan when the reset lands in PLANNING', async () => {
    lifecycle.resolveResumablePhase.mockResolvedValue('PLANNING');
    const { startOverJob } = await import('@/lib/jobs/recovery');
    const result = await startOverJob('job-1');
    expect(result.ok).toBe(true);
    expect(prisma.projectPlan.updateMany).toHaveBeenCalledWith({
      where: { projectId: 'proj-1', status: 'APPROVED' },
      data: { status: 'PENDING' },
    });
  });

  it('leaves plans alone when the project resumes to COMPLETE', async () => {
    lifecycle.resolveResumablePhase.mockResolvedValue('COMPLETE');
    const { startOverJob } = await import('@/lib/jobs/recovery');
    await startOverJob('job-1');
    expect(prisma.projectPlan.updateMany).not.toHaveBeenCalled();
  });
});
