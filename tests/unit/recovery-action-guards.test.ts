import { beforeEach, describe, expect, it, vi } from 'vitest';
import { keepPartialBuild, resolveRecoveryTarget, retryAbandonedJob } from '@/lib/jobs/recovery';
import { dispatchRecoveryRetry, recoveryRetryIntent } from '@/lib/jobs/recovery-retry';

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
  getLatestJobByKind: store.getLatestJobByKind,
  getLatestJobOfKinds: store.getLatestJobOfKinds,
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
  createdAt: new Date('2026-08-19T00:00:00.000Z'),
};

/**
 * The project's job rows, answered the way the kind-scoped lookup asks for them.
 *
 * `getLatestChatJob` asks for the chat kinds and nothing else — in one statement, with the
 * set bound into it — so a row of any other kind is unreachable from the no-jobId fallback
 * however new it is. That is the whole point of the fix: filtering by kind *after*
 * `ORDER BY createdAt DESC LIMIT 1` filters a row that has already been chosen.
 */
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
    expect(store.getLatestJobByKind).not.toHaveBeenCalled();
  });

  it('acts on the named build even when a bookkeeping job is newer', async () => {
    // withRecordedJob writes EXPORT rows for a ZIP download, DOMAIN_VERIFY rows for a domain
    // check. Downloading the ZIP with the recovery panel open used to answer "This project
    // has moved on" about a build that was exactly where it was left.
    store.getJob.mockResolvedValue(JOB);
    jobHistory([
      {
        ...JOB,
        id: 'job-9',
        kind: 'EXPORT',
        status: 'SUCCEEDED',
        createdAt: new Date('2026-08-19T01:00:00.000Z'),
      },
      JOB,
    ]);
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
    // A publish is not a chat kind, so the lookup never asks for one and there is nothing
    // left to refuse: no job, not the wrong job.
    jobHistory([{ ...JOB, kind: 'PUBLISH', status: 'RUNNING' }]);

    const result = await resolveRecoveryTarget('proj-1', undefined);

    expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND', status: 404 });
    expect(result).not.toHaveProperty('job');
    expect(store.getLatestJobByKind).not.toHaveBeenCalledWith('proj-1', 'PUBLISH');
  });

  it('falls back to the newest chat job when the client names none', async () => {
    jobHistory([JOB]);
    store.getActiveJob.mockResolvedValue(null);

    const result = await resolveRecoveryTarget('proj-1', undefined);

    expect(result).toMatchObject({ ok: true, job: { id: 'job-1' } });
    expect(store.getJob).not.toHaveBeenCalled();
  });

  /**
   * The auto quality scan files a settled AUDIT row when it finishes — `insertSettledJob`
   * stamps `createdAt` with the scan's `startedAt`, later than the build's — so on every
   * project that had ever built successfully the newest row was a scan. `getLatestJob` is
   * kind-blind, and the `showsChatRecovery` test below it then refused what it returned, so
   * the fallback answered 409 NOT_RECOVERABLE about a build sitting exactly where it was
   * left: every button on a watchdog-opened recovery panel, dead. One DeepSeek 429 during
   * the scan is enough to produce the row.
   */
  it('resolves the build, not the newer AUDIT row a failed scan left behind', async () => {
    jobHistory([
      { ...JOB, status: 'FAILED' },
      {
        ...JOB,
        id: 'job-scan',
        kind: 'AUDIT',
        status: 'FAILED',
        errorCode: 'provider_error',
        createdAt: new Date('2026-08-19T00:05:00.000Z'),
      },
    ]);
    store.getActiveJob.mockResolvedValue(null);

    const result = await resolveRecoveryTarget('proj-1', undefined);

    expect(result).toMatchObject({ ok: true, job: { id: 'job-1', kind: 'BUILD' } });
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

/**
 * F-033: for BUILD/FOLLOWUP, `recoveryRetryIntent` returned
 * `{ action: 'build', prompt: input.inputPrompt || '' }` with no guard for an empty
 * prompt — unlike the PLAN and IMPORT branches directly above it. `dispatchRecoveryRetry`
 * then created the retry job first and only started the build `if (result.prompt)`, so a
 * FOLLOWUP whose `inputPrompt` was null produced a QUEUED row nothing would ever start:
 * it occupied `one_active_job_per_project`, `applyPhaseForStart` set the phase to BUILDING
 * (chat input locked), and it sat there until the 11-minute queued-stale reaper. The button
 * appeared to do nothing.
 */
describe('Try again on a build with no stored prompt (F-033)', () => {
  it('declines with an explanation instead of promising a build', () => {
    for (const kind of ['BUILD', 'FOLLOWUP']) {
      const intent = recoveryRetryIntent({ kind, errorCode: 'provider_error', inputPrompt: null });
      expect(intent.action, kind).toBe('none');
      expect(intent.action === 'none' && intent.nextStep, kind).toMatch(/prompt/i);
    }
    expect(
      recoveryRetryIntent({ kind: 'BUILD', errorCode: 'provider_error', inputPrompt: '   ' })
        .action,
    ).toBe('none');
  });

  it('still retries a build that has its prompt', () => {
    expect(
      recoveryRetryIntent({
        kind: 'BUILD',
        errorCode: 'provider_error',
        inputPrompt: '  a bakery site ',
      }),
    ).toEqual({ action: 'build', prompt: 'a bakery site' });
  });

  it('creates no job row when the intent declined', async () => {
    const createRetryJob = vi.fn();
    await dispatchRecoveryRetry(
      recoveryRetryIntent({ kind: 'FOLLOWUP', errorCode: 'timeout', inputPrompt: null }),
      {
        startImport: vi.fn(),
        startPlan: vi.fn(),
        startBuild: vi.fn(),
        createRetryJob,
      },
    );
    expect(createRetryJob).not.toHaveBeenCalled();
  });

  it('the server refuses rather than creating a job it cannot start', async () => {
    // Belt and braces: `retryAbandonedJob` computed `job.inputPrompt || planContext || ''`
    // and returned ok with that empty string. For a FOLLOWUP there is no plan context to
    // fall back on, so the row it created was unstartable.
    store.getJob.mockResolvedValue({
      ...JOB,
      kind: 'FOLLOWUP',
      inputPrompt: null,
      filesWritten: 0,
      partialFiles: [],
    });

    const result = await retryAbandonedJob('job-1', 'key-1');

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(result.ok === false && result.error).toMatch(/prompt/i);
    expect(lifecycle.createOrReuseJob).not.toHaveBeenCalled();
  });
});
