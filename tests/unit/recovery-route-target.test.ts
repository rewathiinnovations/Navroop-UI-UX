import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as startOver } from '@/app/api/projects/[id]/job/start-over/route';

/**
 * A recovery click must land on the job the person was looking at.
 *
 * All three recovery routes resolved their target with `getLatestJob` and ignored the
 * client, so the action applied to whatever had become newest since the panel was drawn.
 * "Start over" cancels its target, so on a project whose newest job had become a running
 * PUBLISH it cancelled the publish — mid-deploy, from a chat panel about a build. The
 * route now acts on the job id the client rendered, and the no-jobId path (the client's
 * watchdog opens the panel without a job object) is limited to chat job kinds.
 */

const auth = vi.hoisted(() => ({ getSessionUser: vi.fn() }));
const prisma = vi.hoisted(() => ({
  project: { findFirst: vi.fn() },
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

vi.mock('@/lib/auth', () => ({ getSessionUser: auth.getSessionUser }));
vi.mock('@/lib/db', () => ({ prisma }));
vi.mock('@/lib/checkpoints/actions', () => ({ createCheckpoint: vi.fn() }));
vi.mock('@/lib/projects/plan', () => ({ getApprovedPlanGenerationContext: vi.fn() }));
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

const PUBLISH_JOB = { id: 'job-publish', projectId: 'proj-1', kind: 'PUBLISH', status: 'RUNNING' };
const BUILD_JOB = { id: 'job-build', projectId: 'proj-1', kind: 'BUILD', status: 'ABANDONED' };
const EXPORT_JOB = { id: 'job-export', projectId: 'proj-1', kind: 'EXPORT', status: 'SUCCEEDED' };

function post(body: Record<string, unknown>) {
  return startOver(
    new NextRequest('http://localhost:3000/api/projects/proj-1/job/start-over', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'proj-1' }) },
  );
}

describe('POST /api/projects/[id]/job/start-over', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.getSessionUser.mockResolvedValue({ id: 'user-1', role: 'MEMBER' });
    prisma.project.findFirst.mockResolvedValue({ id: 'proj-1', ownerId: 'user-1' });
    store.getJob.mockResolvedValue(BUILD_JOB);
    lifecycle.resolveResumablePhase.mockResolvedValue('COMPLETE');
  });

  it('does not cancel a running publish when the client names no job', async () => {
    store.getLatestJob.mockResolvedValue(PUBLISH_JOB);

    const response = await post({});

    expect(response.status).toBe(409);
    expect(lifecycle.cancelJob).not.toHaveBeenCalled();
  });

  it('refuses the click while a publish is running, rather than retargeting it', async () => {
    // The panel named the build it drew; a publish started since. Start over rewrites
    // Project.phase, so it may not run behind a live job of any kind — and it must not
    // silently move onto that job either.
    store.getActiveJob.mockResolvedValue(PUBLISH_JOB);

    const response = await post({ jobId: 'job-build' });

    expect(response.status).toBe(409);
    expect(lifecycle.cancelJob).not.toHaveBeenCalled();
  });

  it('starts over on the job the panel rendered', async () => {
    store.getActiveJob.mockResolvedValue(null);

    const response = await post({ jobId: 'job-build' });

    expect(response.status).toBe(200);
    expect(lifecycle.cancelJob).toHaveBeenCalledWith('job-build', 'Start over');
  });

  it('is not blocked by a settled bookkeeping job that happens to be newer', async () => {
    // A ZIP download writes an EXPORT row through withRecordedJob, which becomes the newest
    // job on the project. Judging the named job by whether it is the newest turned that into
    // "This project has moved on" on a build sitting exactly where it was left.
    store.getLatestJob.mockResolvedValue(EXPORT_JOB);
    store.getActiveJob.mockResolvedValue(null);

    const response = await post({ jobId: 'job-build' });

    expect(response.status).toBe(200);
    expect(lifecycle.cancelJob).toHaveBeenCalledWith('job-build', 'Start over');
  });
});
