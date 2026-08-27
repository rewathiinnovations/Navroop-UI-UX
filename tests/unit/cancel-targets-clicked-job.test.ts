import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Stop must stop the build the person clicked Stop on.
 *
 * The three recovery buttons resolve their target through `resolveRecoveryTarget`, which
 * refuses with 409 STALE_JOB when the job the client named is not the one that is live —
 * "a click against a panel drawn seconds earlier hit whatever had started since". Cancel
 * was added later and never read the body at all: it took `getActiveJob(id)` and cancelled
 * that. Between the render and the POST landing, the shown job can settle and the
 * automatic build-fix retry (or a queued follow-up) can start a second one, so Stop
 * cancelled a build nobody asked to stop — and answered 200, so the chat said it worked.
 *
 * AGENTS.md states the rule for all four buttons. These pin cancel against it.
 */

const auth = vi.hoisted(() => ({ getSessionUser: vi.fn() }));
const prisma = vi.hoisted(() => ({ project: { findFirst: vi.fn() } }));
const store = vi.hoisted(() => ({
  claimKeptPartialJob: vi.fn(),
  getActiveJob: vi.fn(),
  getJob: vi.fn(),
  getLatestJobByKind: vi.fn(),
  getLatestJobOfKinds: vi.fn(),
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
vi.mock('@/lib/projects/lock', () => ({ bumpContentVersion: vi.fn() }));
vi.mock('@/lib/jobs/lifecycle', () => ({
  cancelJob: lifecycle.cancelJob,
  createOrReuseJob: lifecycle.createOrReuseJob,
  resolveResumablePhase: lifecycle.resolveResumablePhase,
}));
vi.mock('@/lib/jobs/store', () => ({
  claimKeptPartialJob: store.claimKeptPartialJob,
  getActiveJob: store.getActiveJob,
  getJob: store.getJob,
  getLatestJobByKind: store.getLatestJobByKind,
  getLatestJobOfKinds: store.getLatestJobOfKinds,
  releaseKeptPartialClaim: store.releaseKeptPartialClaim,
  setProjectResumablePhase: store.setProjectResumablePhase,
  settleKeptPartialJob: store.settleKeptPartialJob,
}));

const { POST } = await import('@/app/api/projects/[id]/job/cancel/route');

/** The follow-up the person clicked Stop on. */
const JOB_A = {
  id: 'job-a',
  projectId: 'proj-1',
  kind: 'FOLLOWUP',
  status: 'RUNNING',
  createdAt: new Date('2026-08-20T10:00:00.000Z'),
};
/** The automatic build-fix retry that started between the render and the POST. */
const JOB_B = {
  id: 'job-b',
  projectId: 'proj-1',
  kind: 'BUILD',
  status: 'RUNNING',
  createdAt: new Date('2026-08-20T10:00:20.000Z'),
};
const PUBLISH_JOB = {
  id: 'job-publish',
  projectId: 'proj-1',
  kind: 'PUBLISH',
  status: 'RUNNING',
  createdAt: new Date('2026-08-20T10:01:00.000Z'),
};

/** The chat-kind fallback: one call carrying the whole kind set, newest row inside it back. */
function jobHistory(rows: Array<Record<string, unknown>>) {
  const newestOf = (kinds: readonly string[]) => {
    const matches = rows.filter((row) => kinds.includes(row.kind as string)) as Array<{
      createdAt: Date;
    }>;
    return matches.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
  };
  store.getLatestJobOfKinds.mockImplementation(
    async (_projectId: string, kinds: readonly string[]) => newestOf(kinds),
  );
  store.getLatestJobByKind.mockImplementation(async (_projectId: string, kind: string) =>
    newestOf([kind]),
  );
}

function post(body: Record<string, unknown>) {
  return POST(
    new NextRequest('http://localhost:3000/api/projects/proj-1/job/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'proj-1' }) },
  );
}

async function errorBody(response: Response) {
  return (await response.json()) as { error: { code: string; message: string } };
}

describe('POST /api/projects/[id]/job/cancel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.getSessionUser.mockResolvedValue({ id: 'user-1', role: 'MEMBER' });
    prisma.project.findFirst.mockResolvedValue({ id: 'proj-1', ownerId: 'user-1' });
    jobHistory([JOB_A]);
    lifecycle.cancelJob.mockResolvedValue({ ...JOB_A, status: 'CANCELLED' });
  });

  it('refuses a stale jobId instead of stopping whatever is running now', async () => {
    // The panel was drawn for job A; A settled and the build-fix retry started job B.
    store.getJob.mockResolvedValue({ ...JOB_A, status: 'CANCELLED' });
    store.getActiveJob.mockResolvedValue(JOB_B);

    const response = await post({ jobId: 'job-a' });

    expect(response.status).toBe(409);
    expect((await errorBody(response)).error.code).toBe('STALE_JOB');
    // The build the person never asked to stop is untouched — and not reported as stopped.
    expect(lifecycle.cancelJob).not.toHaveBeenCalled();
  });

  it('stops the job the client named when it is still the live one', async () => {
    store.getJob.mockResolvedValue(JOB_A);
    store.getActiveJob.mockResolvedValue(JOB_A);

    const response = await post({ jobId: 'job-a' });

    expect(response.status).toBe(200);
    expect(lifecycle.cancelJob).toHaveBeenCalledWith('job-a', 'Stopped');
  });

  it('reads the body, so the target is never resolved from the newest row alone', async () => {
    // Both jobs are named-able; only the named one may be cancelled. Before the fix the
    // route never called getJob at all.
    store.getJob.mockResolvedValue(JOB_B);
    store.getActiveJob.mockResolvedValue(JOB_B);

    await post({ jobId: 'job-b' });

    expect(store.getJob).toHaveBeenCalledWith('job-b');
    expect(lifecycle.cancelJob).toHaveBeenCalledWith('job-b', 'Stopped');
  });

  it('says the build already finished rather than cancelling a settled row', async () => {
    store.getJob.mockResolvedValue({ ...JOB_A, status: 'SUCCEEDED' });
    store.getActiveJob.mockResolvedValue(null);

    const response = await post({ jobId: 'job-a' });

    expect(response.status).toBe(409);
    expect((await errorBody(response)).error.code).toBe('ALREADY_SETTLED');
    expect(lifecycle.cancelJob).not.toHaveBeenCalled();
  });

  it('still refuses to stop a publish named from chat', async () => {
    // cancelJob's PUBLISH branch tears down Coolify apps, DNS and deploy repos. The gate
    // now comes from resolveRecoveryTarget, the same one keep/retry/start-over use.
    store.getJob.mockResolvedValue(PUBLISH_JOB);
    store.getActiveJob.mockResolvedValue(PUBLISH_JOB);

    const response = await post({ jobId: 'job-publish' });

    expect(response.status).toBe(409);
    expect((await errorBody(response)).error.code).toBe('NOT_RECOVERABLE');
    expect(lifecycle.cancelJob).not.toHaveBeenCalled();
  });

  it('falls back to the newest chat job when the client names none', async () => {
    // The Stop button is reachable in the second or two before the first poll returns the
    // new row, so `useGenerationJob` has no id to send. A publish is not reachable that
    // way: the fallback only ever looks at chat kinds.
    store.getActiveJob.mockResolvedValue(JOB_A);

    const response = await post({});

    expect(response.status).toBe(200);
    expect(store.getJob).not.toHaveBeenCalled();
    expect(lifecycle.cancelJob).toHaveBeenCalledWith('job-a', 'Stopped');
  });

  it('refuses a job belonging to another project as missing', async () => {
    store.getJob.mockResolvedValue({ ...JOB_A, projectId: 'proj-2' });

    const response = await post({ jobId: 'job-a' });

    expect(response.status).toBe(404);
    expect(lifecycle.cancelJob).not.toHaveBeenCalled();
  });

  it('still refuses a member who does not own the project', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'proj-1', ownerId: 'someone-else' });

    const response = await post({ jobId: 'job-a' });

    expect(response.status).toBe(403);
    expect(store.getJob).not.toHaveBeenCalled();
    expect(lifecycle.cancelJob).not.toHaveBeenCalled();
  });
});
