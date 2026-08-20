import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_JOB_CAPS,
  JobCapError,
  JobCapTracker,
  LOOP_DETECTED_MESSAGE,
} from '../../lib/consumption/caps';
import {
  CREDIT_COSTS,
  checkCredits,
  consumeCredits,
  creditDenialMessage,
  isUnlimited,
} from '../../lib/plans/limits';
import { getPlanCaps } from '../../lib/consumption/plan-caps';
import { chargeJobCreditsOnce } from '../../lib/jobs/lifecycle';
import { createAiMock } from '../mocks';
import type * as LoggerModule from '../../lib/logger';

/**
 * The 80% credit alert runs after `consumeCredits` has committed, so it must never
 * throw: `chargeJobCreditsOnce` reads any throw as "the charge failed", releases the
 * `creditsChargedAt` claim and fails the job `credits_exhausted`. The workspace was
 * already debited, so the retry charged a second time and `creditsUsed` drifted above
 * the ledger permanently. Only the alert is faked here — the debit is the real one.
 */
const tx = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  creditLedger: { create: vi.fn(), aggregate: vi.fn() },
  workspace: { findUniqueOrThrow: vi.fn() },
}));
const db = vi.hoisted(() => ({
  workspace: { upsert: vi.fn(), update: vi.fn(), findUniqueOrThrow: vi.fn() },
  plan: { findUnique: vi.fn(), findFirst: vi.fn() },
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
  $transaction: vi.fn(),
}));
const alerts = vi.hoisted(() => ({ notifyAdminsCredit80: vi.fn() }));
const logger = vi.hoisted(() => ({ logError: vi.fn() }));
// `consumeCredits` reports a dropped 80% alert through `trackFailure`, not `logError`
// (F-306): console output reaches container stdout only, and no operator has been told to
// grep for an event name. The contract under test is that the failure is surfaced to the
// error tracker, so that is what is asserted.
const track = vi.hoisted(() => ({
  trackStart: vi.fn(),
  trackSuccess: vi.fn(),
  trackFailure: vi.fn(),
}));
const store = vi.hoisted(() => ({
  getJob: vi.fn(),
  claimJobCreditCharge: vi.fn(),
  releaseJobCreditCharge: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/plans/alerts', () => ({ notifyAdminsCredit80: alerts.notifyAdminsCredit80 }));
vi.mock('@/lib/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof LoggerModule>()),
  logError: logger.logError,
}));
vi.mock('@/lib/observability/track', () => ({
  trackStart: track.trackStart,
  trackSuccess: track.trackSuccess,
  trackFailure: track.trackFailure,
}));
vi.mock('@/lib/projects/lock', () => ({ acquireLock: vi.fn(), releaseLock: vi.fn() }));
vi.mock('@/lib/jobs/compensate-publish', () => ({ compensateAbandonedPublish: vi.fn() }));
vi.mock('@/lib/jobs/store', () => ({
  claimJobCreditCharge: store.claimJobCreditCharge,
  findJobByIdempotency: vi.fn(),
  getActiveJob: vi.fn(),
  getJob: store.getJob,
  insertJobRaw: vi.fn(),
  listLegacyStuckProjects: vi.fn(),
  listReconcileCandidates: vi.fn(),
  listTimeoutCandidates: vi.fn(),
  releaseJobCreditCharge: store.releaseJobCreditCharge,
  setProjectActiveJob: vi.fn(),
  setProjectResumablePhase: vi.fn(),
  updateJobFields: vi.fn(),
  updateJobIfActive: vi.fn(),
}));

describe('money and limits (unit)', () => {
  it('the credit pre-flight refuses an exhausted workspace before the model runs', async () => {
    // The generate route checks credits at route.ts:314 and returns before it ever
    // reaches the model. This drives that real gate: `checkCredits` reads a mocked
    // exhausted workspace and decides the outcome — the AI mock is wired to the gate,
    // not asserted idle by construction. Delete the pre-flight (or let `checkCredits`
    // stop refusing an exhausted workspace) and `ai.complete` runs, so `ai.invoked` is 1.
    const workspaceId = 'ws_money_limits_preflight';
    db.workspace.upsert.mockResolvedValue({
      id: workspaceId,
      planId: 'plan_exhausted',
      creditsUsed: 100,
      creditsPeriodStart: new Date(Date.now() - 24 * 60 * 60 * 1000),
      creditAlert80Sent: false,
      memberMonthlyCreditCap: null,
      generationPaused: false,
    });
    db.plan.findUnique.mockResolvedValue({ id: 'plan_exhausted', monthlyCredits: 100 });

    const ai = createAiMock('success');
    const check = await checkCredits(workspaceId, 'user_1', 'generation');
    if (check.ok) {
      await ai.complete('build me a landing page');
    }

    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(creditDenialMessage(check.reason)).toMatch(/credits are used up/i);
    }
    expect(ai.invoked).toBe(0);
  });

  it('job caps abort mid-stream', () => {
    const tracker = new JobCapTracker({
      maxTokensPerJob: 10,
      maxFilesPerJob: 1,
      maxOutputBytesPerJob: 40,
    });
    tracker.addFile('a.ts', 'const a = 1');
    const overflow = tracker.addChunk('x'.repeat(200));
    expect(overflow).toBeInstanceOf(JobCapError);
  });

  it('loop detection message is English', () => {
    expect(LOOP_DETECTED_MESSAGE.toLowerCase()).toMatch(/loop|repeat|same/);
  });

  it('plan structural limits treat 0 as a hard stop and -1 as unlimited', () => {
    expect(isUnlimited(-1)).toBe(true);
    expect(isUnlimited(0)).toBe(false);
    expect(CREDIT_COSTS.generation).toBe(1);
  });
});

describe('the 80% credit alert', () => {
  const PLAN = { id: 'plan_1', monthlyCredits: 100 };
  // 80 of 100 is the threshold. The period start is kept inside the current window so
  // `rollCreditPeriodIfNeeded` is a no-op: a roll would zero the counters under test.
  const WORKSPACE = {
    id: 'ws_1',
    planId: PLAN.id,
    creditsUsed: 80,
    creditsPeriodStart: new Date(Date.now() - 24 * 60 * 60 * 1000),
    creditAlert80Sent: false,
    memberMonthlyCreditCap: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    db.workspace.upsert.mockResolvedValue(WORKSPACE);
    db.workspace.update.mockResolvedValue(WORKSPACE);
    db.plan.findUnique.mockResolvedValue(PLAN);
    db.$transaction.mockImplementation((run: (client: typeof tx) => unknown) => run(tx));
    // The alert's own claim UPDATE succeeds; the notify call is what fails.
    db.$queryRaw.mockResolvedValue([{ id: WORKSPACE.id }]);
    tx.$queryRaw.mockResolvedValue([{ id: WORKSPACE.id }]);
    tx.creditLedger.create.mockResolvedValue({ id: 'ledger_1' });
    tx.workspace.findUniqueOrThrow.mockResolvedValue(WORKSPACE);
    store.getJob.mockResolvedValue({ id: 'job_1', creditsChargedAt: null });
    store.claimJobCreditCharge.mockResolvedValue(true);
    alerts.notifyAdminsCredit80.mockRejectedValue(new Error('AppSetting upsert failed'));
  });

  it('a failing alert does not release the creditsChargedAt claim', async () => {
    await expect(
      chargeJobCreditsOnce('job_1', {
        workspaceId: WORKSPACE.id,
        userId: 'user_1',
        action: 'generation',
      }),
    ).resolves.toEqual({ charged: true });
    expect(alerts.notifyAdminsCredit80).toHaveBeenCalledTimes(1);
    expect(tx.creditLedger.create).toHaveBeenCalledTimes(1);
    expect(store.releaseJobCreditCharge).not.toHaveBeenCalled();
    expect(track.trackFailure).toHaveBeenCalledWith(
      'credits.alert_failed',
      expect.any(Error),
      expect.objectContaining({ workspaceId: WORKSPACE.id, action: 'generation' }),
    );
    // The claim UPDATE landed and the alert did not, so the flag is now a receipt for an
    // alert that was never raised. Handing it back is what lets a later debit try again.
    expect(db.workspace.update).toHaveBeenCalledWith({
      where: { id: WORKSPACE.id },
      data: { creditAlert80Sent: false },
    });
  });

  it('a failed claim UPDATE still alerts on a later debit', async () => {
    // The claim fails on the debit that crosses the threshold and succeeds on the next one,
    // which is already past the edge: 81 - 1 = 80 is not < 80, so the old
    // `creditsUsed - cost < threshold` trigger went quiet for the rest of the period and the
    // workspace sailed past 80% with nothing shown at /admin/workspace.
    alerts.notifyAdminsCredit80.mockResolvedValue(true);
    db.$queryRaw
      .mockRejectedValueOnce(new Error('connection reset by peer'))
      .mockResolvedValue([{ id: WORKSPACE.id }]);
    tx.workspace.findUniqueOrThrow
      .mockResolvedValueOnce({ ...WORKSPACE, creditsUsed: 80 })
      .mockResolvedValue({ ...WORKSPACE, creditsUsed: 81 });

    await consumeCredits(WORKSPACE.id, 'user_1', 'generation');
    expect(alerts.notifyAdminsCredit80).not.toHaveBeenCalled();
    expect(track.trackFailure).toHaveBeenCalledWith(
      'credits.alert_failed',
      expect.any(Error),
      expect.objectContaining({ workspaceId: WORKSPACE.id, action: 'generation' }),
    );

    await consumeCredits(WORKSPACE.id, 'user_1', 'generation');
    expect(alerts.notifyAdminsCredit80).toHaveBeenCalledTimes(1);
    // Nothing to hand back this time: the alert was raised under the claim it won.
    expect(db.workspace.update).not.toHaveBeenCalled();
  });

  it('control: a delivered alert is not re-sent on the next debit', async () => {
    // Guards the other direction of the widened trigger — every debit above the threshold
    // now re-evaluates, so the recorded flag has to be what stops the second alert.
    alerts.notifyAdminsCredit80.mockResolvedValue(true);
    tx.workspace.findUniqueOrThrow.mockResolvedValue({
      ...WORKSPACE,
      creditsUsed: 90,
      creditAlert80Sent: true,
    });

    await consumeCredits(WORKSPACE.id, 'user_1', 'generation');
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(alerts.notifyAdminsCredit80).not.toHaveBeenCalled();
  });
});

describe('per-job plan caps', () => {
  const PLAN = {
    id: 'plan_custom',
    monthlyCredits: 100,
    maxTokensPerJob: 24_000,
    maxFilesPerJob: 12,
    maxOutputBytesPerJob: 512_000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    db.workspace.upsert.mockResolvedValue({ id: 'ws_1', planId: PLAN.id });
    db.plan.findUnique.mockResolvedValue(PLAN);
  });

  it('a configured non-default cap survives the read', async () => {
    const caps = await getPlanCaps('ws_1');
    expect(caps).toEqual({
      maxTokensPerJob: 24_000,
      maxFilesPerJob: 12,
      maxOutputBytesPerJob: 512_000,
    });
    // `maxTokensPerJob` bounds real provider spend. The old body SELECTed the three columns
    // with `$queryRaw` and then applied `?? DEFAULT_JOB_CAPS`, so a thin read silently
    // raised this admin's 24 000-token ceiling to 120 000 with nothing logged.
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(caps.maxTokensPerJob).not.toBe(DEFAULT_JOB_CAPS.maxTokensPerJob);
    expect(caps.maxFilesPerJob).not.toBe(DEFAULT_JOB_CAPS.maxFilesPerJob);
    expect(caps.maxOutputBytesPerJob).not.toBe(DEFAULT_JOB_CAPS.maxOutputBytesPerJob);
  });
});
