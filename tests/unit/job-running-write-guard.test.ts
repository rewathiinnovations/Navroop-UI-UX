import { beforeEach, describe, expect, it, vi } from 'vitest';
import { markJobRunning } from '@/lib/jobs/lifecycle';
import { offersRecoveryRetry, recoveryCauseLine } from '@/lib/jobs/copy';
import { CreditLimitError } from '@/lib/plans/limits';
import type * as PlansLimitsModule from '@/lib/plans/limits';
import type { JobUpdateFields } from '@/lib/jobs/store';

/**
 * A settled job must never come back to life.
 *
 * A build parked in the provider queue carries no heartbeat, so the reaper was entitled
 * to abandon it while it waited for a slot. When the slot opened the route still held the
 * QUEUED row it had read minutes earlier and `markJobRunning` wrote through an unguarded
 * UPDATE — so `/admin/jobs` showed a RUNNING job carrying errorCode 'server_restarted'
 * and a finishedAt, the project was back in BUILDING, and a second generation could
 * already be running on it. The status write has to carry the QUEUED/RUNNING guard in the
 * same statement, like every terminal transition does.
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
  updateJobFields: vi.fn(),
  updateJobIfActive: vi.fn(),
  setProjectActiveJob: vi.fn(),
}));
const lock = vi.hoisted(() => ({ acquireLock: vi.fn(), releaseLock: vi.fn() }));
const credits = vi.hoisted(() => ({ consumeCredits: vi.fn() }));

vi.mock('@/lib/db', () => ({ prisma }));
vi.mock('@/lib/projects/lock', () => ({
  acquireLock: lock.acquireLock,
  releaseLock: lock.releaseLock,
}));
// The real module, minus the debit itself: `creditFailureCode` narrows on
// `error instanceof CreditLimitError`, so a stand-in class would make these cases pass
// against a fake and say nothing about the error the debit actually raises.
vi.mock('@/lib/plans/limits', async (importOriginal) => ({
  ...(await importOriginal<typeof PlansLimitsModule>()),
  consumeCredits: credits.consumeCredits,
}));
vi.mock('@/lib/jobs/compensate-publish', () => ({ compensateAbandonedPublish: vi.fn() }));
vi.mock('@/lib/jobs/store', () => ({
  claimJobCreditCharge: vi.fn().mockResolvedValue(true),
  findJobByIdempotency: vi.fn(),
  getActiveJob: vi.fn(),
  getJob: store.getJob,
  insertJobRaw: vi.fn(),
  listLegacyStuckProjects: vi.fn(),
  listReconcileCandidates: vi.fn(),
  listTimeoutCandidates: vi.fn(),
  releaseJobCreditCharge: vi.fn(),
  setProjectActiveJob: store.setProjectActiveJob,
  setProjectResumablePhase: vi.fn(),
  updateJobFields: store.updateJobFields,
  updateJobIfActive: store.updateJobIfActive,
}));

const ABANDONED_JOB = {
  id: 'job-1',
  projectId: 'proj-1',
  userId: 'user-1',
  workspaceId: 'ws-1',
  kind: 'BUILD' as const,
  status: 'ABANDONED' as const,
  startedAt: null,
  filesWritten: 3,
  lastStep: 'writing',
  errorCode: 'server_restarted',
  creditsChargedAt: null,
};

describe('markJobRunning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses to restart a job the reaper already abandoned', async () => {
    store.getJob.mockResolvedValue(ABANDONED_JOB);
    // The conditional UPDATE matches zero rows: the row is no longer QUEUED/RUNNING.
    store.updateJobIfActive.mockResolvedValue(null);

    await expect(
      markJobRunning('job-1', { chargeCredits: false, acquireProjectLock: false }),
    ).rejects.toThrow(/already settled/i);

    // The unguarded writer is the bug: it must not be reached at all.
    expect(store.updateJobFields).not.toHaveBeenCalled();
    // And none of the "this job is starting" side effects may run.
    expect(store.setProjectActiveJob).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(lock.acquireLock).not.toHaveBeenCalled();
  });

  it('carries the active-status guard in the status write', async () => {
    store.getJob.mockResolvedValue({ ...ABANDONED_JOB, status: 'QUEUED', errorCode: null });
    store.updateJobIfActive.mockResolvedValue({ ...ABANDONED_JOB, status: 'RUNNING' });

    await markJobRunning('job-1', { chargeCredits: false, acquireProjectLock: false });

    expect(store.updateJobIfActive).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'RUNNING' }),
    );
    expect(store.updateJobFields).not.toHaveBeenCalled();
    expect(store.setProjectActiveJob).toHaveBeenCalledWith('proj-1', 'job-1');
  });

  /**
   * What the job records when the credit debit refuses or breaks.
   *
   * Every throw out of `consumeCredits` was written down as `credits_exhausted`, which is in
   * `NO_RETRY_CODES` and whose next-step line is "Add credits, or wait for the monthly
   * reset". Two of the three things that throw there are not that: a member-cap refusal
   * (the workspace has credits, an admin has to raise one person's cap) and the debit
   * failing to run at all (Prisma P2028, a dropped connection). Both told the person to buy
   * credits they already had and took the Try-again button away.
   */
  describe('credit charge failures', () => {
    const QUEUED_JOB = { ...ABANDONED_JOB, status: 'QUEUED' as const, errorCode: null };

    function arrangeStart() {
      store.getJob.mockResolvedValue(QUEUED_JOB);
      store.updateJobIfActive.mockResolvedValue({ ...QUEUED_JOB, status: 'RUNNING' });
      prisma.project.findUnique.mockResolvedValue({ lastCode: null });
      prisma.checkpoint.count.mockResolvedValue(0);
      prisma.projectPlan.findFirst.mockResolvedValue(null);
    }

    /** The FAILED write `failJob` made, which is what /admin/jobs and the panel read. */
    function settledWith(): JobUpdateFields | undefined {
      const writes: Array<[string, JobUpdateFields]> = store.updateJobIfActive.mock.calls;
      return writes.find(([, fields]) => fields.status === 'FAILED')?.[1];
    }

    it('records a member cap as its own code, keeps the debit sentence, and still offers a retry', async () => {
      arrangeStart();
      const denial = new CreditLimitError('member_cap');
      credits.consumeCredits.mockRejectedValue(denial);

      await expect(
        markJobRunning('job-1', { chargeCredits: true, acquireProjectLock: false }),
      ).rejects.toBe(denial);

      const settled = settledWith();
      expect(settled?.errorCode).toBe('member_cap_reached');
      // The debit raises the one sentence that names the remedy; it has to survive the trip.
      expect(settled?.errorMessage).toBe(denial.message);
      expect(recoveryCauseLine(settled?.errorCode, settled?.errorMessage)).toBe(denial.message);
      // Raising the cap makes the same request succeed, so suppressing Try-again removed the
      // only way forward.
      expect(
        offersRecoveryRetry({
          kind: 'BUILD',
          errorCode: settled?.errorCode,
          errorMessage: settled?.errorMessage,
        }),
      ).toBe(true);
    });

    it('does not report a transaction timeout as exhausted credits', async () => {
      arrangeStart();
      // What Prisma raises when the interactive transaction inside consumeCredits runs out
      // of time. Nothing about the workspace's balance is known from this.
      const infrastructure = new Error(
        'Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction (P2028)',
      );
      credits.consumeCredits.mockRejectedValue(infrastructure);

      await expect(
        markJobRunning('job-1', { chargeCredits: true, acquireProjectLock: false }),
      ).rejects.toBe(infrastructure);

      const settled = settledWith();
      expect(settled?.errorCode).toBe('credit_charge_failed');
      expect(settled?.errorCode).not.toBe('credits_exhausted');
      // The raw Prisma string is kept for /admin/jobs but must not be shown as the cause.
      expect(recoveryCauseLine(settled?.errorCode, settled?.errorMessage)).not.toContain('P2028');
      expect(
        offersRecoveryRetry({
          kind: 'BUILD',
          errorCode: settled?.errorCode,
          errorMessage: settled?.errorMessage,
        }),
      ).toBe(true);
    });

    it('still reports a workspace with no credits left as exhausted', async () => {
      arrangeStart();
      const denial = new CreditLimitError('workspace_exhausted');
      credits.consumeCredits.mockRejectedValue(denial);

      await expect(
        markJobRunning('job-1', { chargeCredits: true, acquireProjectLock: false }),
      ).rejects.toBe(denial);

      expect(settledWith()?.errorCode).toBe('credits_exhausted');
    });
  });
});
