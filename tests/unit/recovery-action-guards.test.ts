import { beforeEach, describe, expect, it, vi } from 'vitest';
import { keepPartialBuild, resolveRecoveryTarget, retryAbandonedJob } from '@/lib/jobs/recovery';

/**
 * What a recovery click is allowed to do.
 *
 * Three separate ways this went wrong. "Keep what was built" wrote
 * `status = 'SUCCEEDED'` with no status guard, and the panel offering it opens on a
 * 90-second heartbeat gap rather than on the job's status — so it settled builds that
 * were still streaming, and their real output landed on an already-SUCCEEDED row and was
 * dropped. All three routes resolved their own target with `getLatestJob`, so a click made
 * against a panel drawn seconds earlier applied to whatever had started since. And a
 * retry copied `creditsChargedAt` forward, which makes `chargeJobCreditsOnce`
 * short-circuit — every "Try again" ran a full build for free while the panel promised
 * "Try again starts a new billed build".
 */

const prisma = vi.hoisted(() => ({
  project: {
    update: vi.fn(),
    // The merge (F-020) reads the current site before writing; no base by default.
    findUnique: vi.fn().mockResolvedValue({ lastCode: null }),
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

vi.mock('@/lib/db', () => ({ prisma }));
vi.mock('@/lib/checkpoints/actions', () => ({ createCheckpoint: checkpoints.createCheckpoint }));
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
  getLatestJob: store.getLatestJob,
  releaseKeptPartialClaim: store.releaseKeptPartialClaim,
  setProjectResumablePhase: store.setProjectResumablePhase,
  settleKeptPartialJob: store.settleKeptPartialJob,
}));

const JOB = {
  id: 'job-1',
  projectId: 'proj-1',
  userId: 'user-1',
  workspaceId: 'ws-1',
  kind: 'BUILD' as const,
  status: 'ABANDONED' as const,
  attempt: 1,
  maxAttempts: 2,
  filesWritten: 1,
  partialFiles: [{ path: 'app/page.tsx', content: '<main />' }],
  inputPrompt: 'build a landing page',
  planVersion: 1,
  lastStep: 'writing_files',
  errorCode: 'provider_error',
  creditsChargedAt: new Date('2026-08-19T00:00:00.000Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('keepPartialBuild', () => {
  it('refuses a job that is still running', async () => {
    store.getJob.mockResolvedValue({ ...JOB, status: 'RUNNING', errorCode: null });

    const result = await keepPartialBuild('job-1');

    expect(result).toMatchObject({ ok: false, status: 409 });
    // Nothing may be written: the generation is still producing the real file set.
    expect(store.claimKeptPartialJob).not.toHaveBeenCalled();
    expect(store.settleKeptPartialJob).not.toHaveBeenCalled();
    expect(prisma.project.update).not.toHaveBeenCalled();
    expect(checkpoints.createCheckpoint).not.toHaveBeenCalled();
  });

  it('claims the job before saving, so a second click changes nothing', async () => {
    store.getJob.mockResolvedValue(JOB);
    // The conditional UPDATE matched zero rows — someone already kept or settled this job.
    store.claimKeptPartialJob.mockResolvedValue(false);

    const result = await keepPartialBuild('job-1');

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(prisma.project.update).not.toHaveBeenCalled();
    expect(checkpoints.createCheckpoint).not.toHaveBeenCalled();
    expect(store.settleKeptPartialJob).not.toHaveBeenCalled();
  });

  it('saves the partial file set once the claim is won', async () => {
    store.getJob.mockResolvedValue(JOB);
    store.claimKeptPartialJob.mockResolvedValue(true);
    store.settleKeptPartialJob.mockResolvedValue(true);

    const result = await keepPartialBuild('job-1');

    expect(result).toMatchObject({ ok: true, filesWritten: 1 });
    expect(prisma.project.update).toHaveBeenCalledTimes(1);
    expect(checkpoints.createCheckpoint).toHaveBeenCalledTimes(1);
    // The settle comes after the files are stored, never before.
    expect(store.settleKeptPartialJob).toHaveBeenCalledWith('job-1');
    expect(store.releaseKeptPartialClaim).not.toHaveBeenCalled();
    expect(store.setProjectResumablePhase).toHaveBeenCalledWith('proj-1', 'COMPLETE', 'ready');
  });

  it('hands the claim back when the checkpoint write fails, instead of settling the job', async () => {
    // The claim used to be the settle: the row went SUCCEEDED first, so a storage 5xx here
    // left the build unreachable — no lastCode, no checkpoint, and every further click
    // answered "already settled" because the row no longer matched ABANDONED/FAILED.
    store.getJob.mockResolvedValue(JOB);
    store.claimKeptPartialJob.mockResolvedValue(true);
    checkpoints.createCheckpoint.mockRejectedValue(new Error('snapshot upload failed: 503'));

    await expect(keepPartialBuild('job-1')).rejects.toThrow(/503/);

    // Still ABANDONED, so the panel can offer this again — and the progress string the
    // panel reads is put back the way it was found.
    expect(store.settleKeptPartialJob).not.toHaveBeenCalled();
    expect(store.releaseKeptPartialClaim).toHaveBeenCalledWith('job-1', 'writing_files');
    expect(store.setProjectResumablePhase).not.toHaveBeenCalled();
  });
});

describe('resolveRecoveryTarget', () => {
  it('rejects a named job while another job is live, without retargeting it', async () => {
    // The panel was drawn for job-1; a publish has started since. All three actions rewrite
    // Project.phase, so acting on the old panel while something else is running is the
    // thing to refuse — not the click itself.
    store.getJob.mockResolvedValue(JOB);
    store.getActiveJob.mockResolvedValue({
      ...JOB,
      id: 'job-2',
      kind: 'PUBLISH',
      status: 'RUNNING',
    });

    const result = await resolveRecoveryTarget('proj-1', 'job-1');

    expect(result).toMatchObject({ ok: false, code: 'STALE_JOB', status: 409 });
    expect(result).not.toHaveProperty('job');
    // A named job is judged on its own row. Asking "is it the newest?" instead is what made
    // a ZIP download lock the panel out.
    expect(store.getLatestJob).not.toHaveBeenCalled();
  });

  it('acts on the named build even when a bookkeeping job is newer', async () => {
    // withRecordedJob writes EXPORT rows for a ZIP download, DOMAIN_VERIFY rows for a domain
    // check. Downloading the ZIP with the recovery panel open used to answer "This project
    // has moved on" about a build that was exactly where it was left.
    store.getJob.mockResolvedValue(JOB);
    store.getLatestJob.mockResolvedValue({
      ...JOB,
      id: 'job-9',
      kind: 'EXPORT',
      status: 'SUCCEEDED',
    });
    store.getActiveJob.mockResolvedValue(null);

    const result = await resolveRecoveryTarget('proj-1', 'job-1');

    expect(result).toMatchObject({ ok: true, job: { id: 'job-1' } });
  });

  it('treats a job from another project as missing', async () => {
    store.getJob.mockResolvedValue({ ...JOB, projectId: 'proj-2' });

    const result = await resolveRecoveryTarget('proj-1', 'job-1');

    expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND', status: 404 });
    expect(result).not.toHaveProperty('job');
  });

  it('rejects a job that was not started from chat', async () => {
    store.getJob.mockResolvedValue({ ...JOB, kind: 'PUBLISH', status: 'RUNNING' });

    const result = await resolveRecoveryTarget('proj-1', 'job-1');

    expect(result).toMatchObject({ ok: false, code: 'NOT_RECOVERABLE', status: 409 });
  });

  it('will not reach a running publish when the client names no job', async () => {
    // The watchdog can open the recovery panel with no job object, so the server falls back
    // to the newest job — this is the case where that fallback used to cancel a publish.
    store.getLatestJob.mockResolvedValue({ ...JOB, kind: 'PUBLISH', status: 'RUNNING' });

    const result = await resolveRecoveryTarget('proj-1', undefined);

    expect(result).toMatchObject({ ok: false, code: 'NOT_RECOVERABLE', status: 409 });
    expect(result).not.toHaveProperty('job');
  });

  it('falls back to the newest chat job when the client names none', async () => {
    store.getLatestJob.mockResolvedValue(JOB);
    store.getActiveJob.mockResolvedValue(null);

    const result = await resolveRecoveryTarget('proj-1', undefined);

    expect(result).toMatchObject({ ok: true, job: { id: 'job-1' } });
    expect(store.getJob).not.toHaveBeenCalled();
  });

  it('returns the job when the panel is still current', async () => {
    store.getJob.mockResolvedValue(JOB);
    store.getActiveJob.mockResolvedValue(null);

    const result = await resolveRecoveryTarget('proj-1', 'job-1');

    expect(result).toMatchObject({ ok: true, job: { id: 'job-1' } });
  });

  it('lets the live job itself through, which is what Start over acts on', async () => {
    // The watchdog opens the panel on a heartbeat gap while the build is still RUNNING, so
    // the job the panel named is also the active job. That is not a stale panel.
    const running = { ...JOB, status: 'RUNNING' as const, errorCode: null };
    store.getJob.mockResolvedValue(running);
    store.getActiveJob.mockResolvedValue(running);

    const result = await resolveRecoveryTarget('proj-1', 'job-1');

    expect(result).toMatchObject({ ok: true, job: { id: 'job-1' } });
  });
});

describe('retryAbandonedJob', () => {
  it('charges a fresh retry', async () => {
    // filesWritten > 0 but the attempt cap is reached, so this is a fresh build, not a
    // resume — exactly the case the panel calls "a new billed build".
    store.getJob.mockResolvedValue({ ...JOB, attempt: 2, maxAttempts: 2 });
    lifecycle.createOrReuseJob.mockResolvedValue({ ...JOB, id: 'job-2', status: 'QUEUED' });

    const result = await retryAbandonedJob('job-1', 'key-1');

    expect(result.ok).toBe(true);
    expect(lifecycle.createOrReuseJob).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, creditsChargedAt: null }),
    );
  });

  it('keeps the charge stamp when it resumes the build that was already billed', async () => {
    store.getJob.mockResolvedValue(JOB);
    lifecycle.createOrReuseJob.mockResolvedValue({ ...JOB, id: 'job-2', status: 'QUEUED' });

    const result = await retryAbandonedJob('job-1', 'key-1');

    expect(result).toMatchObject({ ok: true, resume: true });
    expect(lifecycle.createOrReuseJob).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 2, creditsChargedAt: JOB.creditsChargedAt }),
    );
  });

  it('refuses to retry a build that has not stopped', async () => {
    // The panel is open on the watchdog, not on the status. Retrying a live build is a
    // silent no-op dressed as a 200: createOrReuseJob hands back the job that is already
    // active and the stream route short-circuits with { reused: true }.
    store.getJob.mockResolvedValue({ ...JOB, status: 'RUNNING', errorCode: null });

    const result = await retryAbandonedJob('job-1', 'key-1');

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(lifecycle.createOrReuseJob).not.toHaveBeenCalled();
  });

  it('does not bill again when our own restart produced nothing', async () => {
    // abandonInstanceJobs('deploying') settles a build 20 seconds in during a rolling
    // deploy: zero files, errorCode server_restarted. shouldResumePartial is false with no
    // files, so billing on that basis alone debited a second credit for our redeploy and
    // delivered nothing twice — and nothing refunds creditsChargedAt.
    store.getJob.mockResolvedValue({
      ...JOB,
      filesWritten: 0,
      partialFiles: [],
      errorCode: 'server_restarted',
    });
    lifecycle.createOrReuseJob.mockResolvedValue({ ...JOB, id: 'job-2', status: 'QUEUED' });

    const result = await retryAbandonedJob('job-1', 'key-1');

    expect(result).toMatchObject({ ok: true, resume: false });
    expect(lifecycle.createOrReuseJob).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, creditsChargedAt: JOB.creditsChargedAt }),
    );
  });
});
