import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The five holes the closure audit found in round 2's unmetered auto-scan path.
 *
 *  A(i)  Check-then-act across an await. `runAutoCodeAudit` read `inflight.has(projectId)`
 *        and the entry was written only at the far end of `startDetachedCodeScan`, with
 *        `projectHasPublishableFiles` in between. Node interleaves at every await, so an
 *        owner firing N parallel POSTs of one settled build cleared the guard N times and
 *        bought N concurrent `runAiReview` calls on the workspace's provider key — none of
 *        them charged, because not charging is the entire point of this path.
 *  A(ii) The replay guard closed only on success. It asked for a `CodeAudit` row newer than
 *        the build, and `performCodeAudit` writes that row only after `runCodeScan` returns.
 *        A scan killed by a 429 or a timeout wrote nothing, so the warrant stayed open and
 *        the same job id bought a fresh billed provider call for the full fifteen minutes.
 *  B     The manual Scan button was free whenever another job was live. `checkCredits` only
 *        reads the balance; the spend lived inside `markJobRunning({ chargeCredits: true })`,
 *        which the `!ownRow` branch returns before reaching. A user whose own BUILD was
 *        running got that row back from the kind-blind `createOrReuseJob`, fell to the
 *        detached path, and ran the whole AI review with no audit credit charged.
 *  C     `ownRow` accepted a row whose `currentStep` was still NULL, and the stamp landed an
 *        await later — so between the two the row belonged to neither scan and both could
 *        claim it. Code and SEO then shared one row, and a failing code scan was reported by
 *        `getLatestSeoAudit` as an SEO failure while `getLatestCodeAudit` found nothing. The
 *        conditional stamp that closed that gap has since been overtaken by the round that
 *        took the live job row off the manual Scan as well (defect A above was reachable
 *        from the button): no scan holds a row, so there is nothing left to claim. C below
 *        pins the property rather than the mechanism — the two flavours stay separable —
 *        and asserts that the row is never asked for.
 *  D     The same check-then-act on the manual path: two clicks both started a scan, and the
 *        first one's `finally` deleted the map entry the second owned, so the panel's
 *        spinner stopped and the Scan button came back mid-scan.
 *
 * `tests/unit/quality-scan-slot-and-credits.test.ts` pins round 2's constraints — no job
 * slot, no credit, no lock on the auto path, and one row per scan flavour. Those still hold
 * and are not repeated here; this file only pins that the guards around them bind.
 */

const prisma = vi.hoisted(() => ({
  project: { findFirst: vi.fn() },
  codeAudit: { findFirst: vi.fn(), create: vi.fn() },
  seoAudit: { findFirst: vi.fn(), create: vi.fn() },
  job: { findFirst: vi.fn() },
}));
const auth = vi.hoisted(() => ({ getSessionUser: vi.fn() }));
const publishFiles = vi.hoisted(() => ({
  projectHasPublishableFiles: vi.fn(),
  PUBLISH_FILES_UNAVAILABLE:
    "We could not read this project's files from storage. Try again in a few minutes.",
}));
const lock = vi.hoisted(() => ({ holdProjectLock: vi.fn() }));
const credits = vi.hoisted(() => ({ checkCredits: vi.fn(), consumeCredits: vi.fn() }));
const store = vi.hoisted(() => ({
  insertSettledJob: vi.fn(),
  findRecentlySucceededBuild: vi.fn(),
  updateJobFields: vi.fn(),
  claimAuditJobStep: vi.fn(),
}));
const lifecycle = vi.hoisted(() => ({
  beginJobHeartbeat: vi.fn(),
  createOrReuseJob: vi.fn(),
  failJob: vi.fn(),
  markJobRunning: vi.fn(),
  succeedJob: vi.fn(),
}));
const scans = vi.hoisted(() => ({ runCodeScan: vi.fn(), runSeoChecks: vi.fn() }));

vi.mock('@/lib/db', () => ({ prisma }));
vi.mock('@/lib/auth', () => ({ getSessionUser: auth.getSessionUser }));
vi.mock('@/lib/projects/plan', () => ({
  peekActor: () => null,
  startFollowUpGeneration: vi.fn(),
}));
vi.mock('@/lib/checkpoints/snapshot', () => ({ captureFileSnapshot: vi.fn(async () => []) }));
vi.mock('@/lib/signals/collect', () => ({
  recordCodeAuditSignals: vi.fn(),
  recordSeoScore: vi.fn(),
}));
vi.mock('@/lib/publish/files', () => publishFiles);
vi.mock('@/lib/projects/lock', () => ({ holdProjectLock: lock.holdProjectLock }));
vi.mock('@/lib/plans/limits', () => credits);
vi.mock('@/lib/preview/url', () => ({ auditPreviewUrl: vi.fn(async () => null) }));
vi.mock('@/lib/audit/scan', () => ({ runCodeScan: scans.runCodeScan }));
vi.mock('@/lib/seo/scan', () => ({ runSeoChecks: scans.runSeoChecks }));
vi.mock('@/lib/seo/live', () => ({
  fetchPreviewDocument: vi.fn(async () => null),
  fetchPreviewText: vi.fn(async () => null),
}));
vi.mock('@/lib/seo/lighthouse', () => ({ runLighthouseSeo: vi.fn(async () => []) }));
vi.mock('@/lib/jobs/store', () => store);
vi.mock('@/lib/jobs/lifecycle', () => lifecycle);
vi.mock('@/lib/jobs/step-failure', () => ({ recordJobStepFailure: vi.fn() }));

import { isCodeScanInFlight, runAutoCodeAudit, runCodeAudit } from '@/lib/audit/actions';
import { runAutoSeoAudit, runSeoAudit } from '@/lib/seo/actions';
import { CODE_AUDIT_STEP, SEO_AUDIT_STEP } from '@/lib/audit/poll-state';

const USER = { id: 'user-1', role: 'MEMBER' };
/** `performCodeAudit` reads `stack`/`designDirection`/`ownerId` off this row. */
const PROJECT = { id: 'p1', ownerId: 'user-1', stack: 'NEXTJS', designDirection: null };
const BUILD_ID = 'job_build_1';
/**
 * Relative to the real clock, because A(ii) compares the build against the wall-clock
 * `startedAt` a detached scan stamps on its own record. A fixed literal put the build in
 * the future and the attempt could never be newer than it.
 */
const BUILT_AT = new Date(Date.now() - 60_000);

/** The scans are detached; give their promise chains a turn before asserting. */
const scanTicks = () => new Promise((resolve) => setTimeout(resolve, 20));

/**
 * Start `count` auto-scan calls and hand back their still-pending promises.
 *
 * The overlap is forced by the caller holding `projectHasPublishableFiles` open, not by the
 * calls literally starting on one tick: both actions reach the job store through
 * `await import('@/lib/jobs/store')`, and several of those resolving at once hand some
 * callers the real module instead of the mock — a property of Vitest's loader that would
 * make this a test of the loader. Entry is therefore staggered by a tick and every call is
 * still parked inside the eligibility pipeline, which is the window the defect lives in: the
 * old code read `inflight.has` before that await and wrote the entry only after it.
 */
async function allInFlight<T>(count: number, start: () => Promise<T>): Promise<Array<Promise<T>>> {
  const calls: Array<Promise<T>> = [];
  for (let index = 0; index < count; index += 1) {
    calls.push(start());
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return calls;
}

/**
 * The AUDIT job rows the run has filed so far.
 *
 * A(ii) turns on a row written by a scan that *failed*, so stubbing the guard's answer
 * directly would assert nothing. `insertSettledJob` appends here and `prisma.job.findFirst`
 * reads it back, which is the real chain: the detached scan's own record is what closes the
 * warrant it was granted.
 */
type FiledJob = { projectId: string; kind: string; currentStep: string | null; createdAt: Date };
let filedJobs: FiledJob[] = [];

/**
 * The `currentStep` each AUDIT row carries, backing `claimAuditJobStep` below.
 *
 * A fixture for a seam neither scan reaches any more: closing defect A took the live job
 * row off both paths, so nothing claims a step. It is kept, and kept behaving like the real
 * conditional stamp, so that a scan which started claiming rows again fails the
 * `not.toHaveBeenCalled` guards in C legibly instead of on a missing mock export.
 */
let stampedSteps: Map<string, string> = new Map();

type SettledJobInput = {
  projectId: string;
  kind: string;
  startedAt: Date;
  currentStep?: string | null;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  filedJobs = [];
  stampedSteps = new Map();
  auth.getSessionUser.mockResolvedValue(USER);
  prisma.project.findFirst.mockResolvedValue(PROJECT);
  prisma.codeAudit.findFirst.mockResolvedValue(null);
  prisma.seoAudit.findFirst.mockResolvedValue(null);
  prisma.codeAudit.create.mockResolvedValue({ id: 'audit-1' });
  prisma.seoAudit.create.mockResolvedValue({ id: 'seo-1' });
  // The attempt guard's read, answered from what the run has actually filed.
  prisma.job.findFirst.mockImplementation(
    async (args: {
      where: {
        projectId: string;
        kind: string;
        currentStep: string;
        createdAt?: { gte: Date };
      };
    }) => {
      const { where } = args;
      const hit = filedJobs.find(
        (row) =>
          row.projectId === where.projectId &&
          row.kind === where.kind &&
          row.currentStep === where.currentStep &&
          (!where.createdAt || row.createdAt.getTime() >= where.createdAt.gte.getTime()),
      );
      return hit ? { id: 'job_filed', errorMessage: null, finishedAt: null } : null;
    },
  );
  publishFiles.projectHasPublishableFiles.mockResolvedValue({ status: 'ready' });
  lock.holdProjectLock.mockResolvedValue({ ok: true, release: vi.fn(async () => undefined) });
  credits.checkCredits.mockResolvedValue({ ok: true });
  credits.consumeCredits.mockResolvedValue(undefined);
  store.insertSettledJob.mockImplementation(async (input: SettledJobInput) => {
    filedJobs.push({
      projectId: input.projectId,
      kind: input.kind,
      currentStep: input.currentStep ?? null,
      createdAt: input.startedAt,
    });
    return { id: `job_record_${filedJobs.length}` };
  });
  store.updateJobFields.mockResolvedValue(null);
  // The conditional stamp, modelled as the one statement it is: the read and the write have
  // no await between them, so a loser would read the winner's step rather than a NULL. See
  // `stampedSteps` — no scan calls this now, and C asserts that.
  store.claimAuditJobStep.mockImplementation(async (jobId: string, step: string) => {
    await Promise.resolve();
    const current = stampedSteps.get(jobId) ?? null;
    if (current !== null && current !== step) return false;
    stampedSteps.set(jobId, step);
    return true;
  });
  store.findRecentlySucceededBuild.mockResolvedValue({
    id: BUILD_ID,
    projectId: 'p1',
    userId: 'user-1',
    kind: 'BUILD',
    status: 'SUCCEEDED',
    finishedAt: BUILT_AT,
  });
  lifecycle.beginJobHeartbeat.mockReturnValue({ stop: vi.fn() });
  lifecycle.createOrReuseJob.mockResolvedValue({
    id: 'job_audit_1',
    kind: 'AUDIT',
    status: 'QUEUED',
    currentStep: null,
  });
  lifecycle.markJobRunning.mockResolvedValue(null);
  lifecycle.succeedJob.mockResolvedValue(null);
  lifecycle.failJob.mockResolvedValue(null);
  scans.runCodeScan.mockResolvedValue({ findings: [], metrics: {}, signals: {} });
  scans.runSeoChecks.mockReturnValue([]);
});

/* ------------------------------------------ A(i): the claim closes over every await */

describe('A(i) one warrant buys exactly one scan, however many callers race for it', () => {
  it('starts one code scan for N parallel calls naming the same settled build', async () => {
    // Held open so every caller is inside the eligibility pipeline at once — the exact gap
    // the old `has` … `set` pair spanned.
    const readiness = deferred<{ status: 'ready' }>();
    publishFiles.projectHasPublishableFiles.mockReturnValue(readiness.promise);

    const calls = await allInFlight(6, () => runAutoCodeAudit('p1', BUILD_ID));
    readiness.resolve({ status: 'ready' });
    const results = await Promise.all(calls);
    await scanTicks();

    // Every caller is told a scan is happening, because one is — but only one ran, and only
    // one AI review was bought on the workspace's key.
    expect(results.every((result) => result.ok)).toBe(true);
    expect(scans.runCodeScan).toHaveBeenCalledTimes(1);
    expect(store.insertSettledJob).toHaveBeenCalledTimes(1);
    // Round 2's constraints have to survive the concurrency, not just the single call.
    expect(credits.consumeCredits).not.toHaveBeenCalled();
    expect(credits.checkCredits).not.toHaveBeenCalled();
    expect(lifecycle.createOrReuseJob).not.toHaveBeenCalled();
    expect(lock.holdProjectLock).not.toHaveBeenCalled();
  });

  it('starts one SEO scan for N parallel calls naming the same settled build', async () => {
    const readiness = deferred<{ status: 'ready' }>();
    publishFiles.projectHasPublishableFiles.mockReturnValue(readiness.promise);

    const calls = await allInFlight(6, () => runAutoSeoAudit('p1', BUILD_ID));
    readiness.resolve({ status: 'ready' });
    await Promise.all(calls);
    await scanTicks();

    expect(scans.runSeoChecks).toHaveBeenCalledTimes(1);
    expect(store.insertSettledJob).toHaveBeenCalledTimes(1);
    expect(credits.consumeCredits).not.toHaveBeenCalled();
  });

  it('gives the claim back when there was nothing to scan, so the next build still gets one', async () => {
    // The claim is now taken before the readiness read, so every exit between the two has to
    // release it. One stranded here would report a scan in flight for the life of the
    // process and silently swallow the next build's scan.
    publishFiles.projectHasPublishableFiles.mockResolvedValueOnce({ status: 'empty' });

    const empty = await runAutoCodeAudit('p1', BUILD_ID);
    await scanTicks();
    expect(empty).toMatchObject({ ok: true, data: { scanning: false } });
    expect(scans.runCodeScan).not.toHaveBeenCalled();

    const ready = await runAutoCodeAudit('p1', BUILD_ID);
    await scanTicks();
    expect(ready).toMatchObject({ ok: true, data: { scanning: true } });
    expect(scans.runCodeScan).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------- A(ii): the warrant closes on the attempt, not the success */

describe('A(ii) a scan that failed still closes its warrant', () => {
  it('refuses to replay a job id whose code scan died in the AI review', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    scans.runCodeScan.mockRejectedValue(new Error('429 Too Many Requests'));

    await runAutoCodeAudit('p1', BUILD_ID);
    await scanTicks();

    // The success guard has nothing to read: a scan that threw writes no CodeAudit row, so
    // on that guard alone this warrant is still open and every replay is a billed call.
    expect(scans.runCodeScan).toHaveBeenCalledTimes(1);
    expect(prisma.codeAudit.create).not.toHaveBeenCalled();
    expect(filedJobs).toHaveLength(1);
    expect(filedJobs[0].currentStep).toBe(CODE_AUDIT_STEP);

    const replay = await runAutoCodeAudit('p1', BUILD_ID);
    await scanTicks();

    expect(replay).toMatchObject({ ok: true, data: { scanning: false } });
    expect(scans.runCodeScan).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('refuses to replay a job id whose SEO scan died mid-run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    scans.runSeoChecks.mockImplementation(() => {
      throw new Error('preview fetch timed out');
    });

    await runAutoSeoAudit('p1', BUILD_ID);
    await scanTicks();
    expect(prisma.seoAudit.create).not.toHaveBeenCalled();

    const replay = await runAutoSeoAudit('p1', BUILD_ID);
    await scanTicks();

    expect(replay).toMatchObject({ ok: true, data: { scanning: false } });
    expect(scans.runSeoChecks).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('does not let a scan that predates the build close that build’s warrant', async () => {
    // The attempt record is compared against `finishedAt`, not merely "one exists". A scan
    // the user ran before this build finished says nothing about this build's code.
    filedJobs.push({
      projectId: 'p1',
      kind: 'AUDIT',
      currentStep: CODE_AUDIT_STEP,
      createdAt: new Date(BUILT_AT.getTime() - 60_000),
    });

    const result = await runAutoCodeAudit('p1', BUILD_ID);
    await scanTicks();

    expect(result).toMatchObject({ ok: true, data: { scanning: true } });
    expect(scans.runCodeScan).toHaveBeenCalledTimes(1);
  });

  it('does not let the SEO attempt record close the code warrant', async () => {
    // The two flavours are told apart by the marker, exactly as the panels read them.
    filedJobs.push({
      projectId: 'p1',
      kind: 'AUDIT',
      currentStep: SEO_AUDIT_STEP,
      createdAt: new Date(BUILT_AT.getTime() + 1_000),
    });

    const result = await runAutoCodeAudit('p1', BUILD_ID);
    await scanTicks();

    expect(result).toMatchObject({ ok: true, data: { scanning: true } });
    expect(scans.runCodeScan).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------- B: metering is branch-independent */

describe('B a manual Scan charges once, whatever else is live on the project', () => {
  const liveForeignRow = {
    id: 'job_followup_1',
    kind: 'FOLLOWUP',
    status: 'RUNNING',
    currentStep: 'generate',
  };

  it('charges an audit credit while another job is running on the project', async () => {
    lifecycle.createOrReuseJob.mockResolvedValue(liveForeignRow);

    const result = await runCodeAudit('p1');
    await scanTicks();

    expect(result).toMatchObject({ ok: true, data: { scanning: true } });
    expect(scans.runCodeScan).toHaveBeenCalledTimes(1);
    // `checkCredits` only reads the balance; this is the spend. It used to live inside
    // `markJobRunning({ chargeCredits: true })`, reached only while the scan owned a
    // QUEUED row — so a user whose own BUILD was live got that foreign row back from the
    // kind-blind `createOrReuseJob` and ran the whole AI review free. No scan asks for a
    // row now, so the fixture above is never read and the charge cannot be branch-dependent
    // again; that it is never read is asserted rather than assumed.
    expect(lifecycle.createOrReuseJob).not.toHaveBeenCalled();
    expect(credits.consumeCredits).toHaveBeenCalledTimes(1);
    expect(credits.consumeCredits).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'audit',
      'p1',
    );
    expect(lifecycle.markJobRunning).not.toHaveBeenCalled();
  });

  it('charges an audit credit for the SEO scan on the same terms', async () => {
    lifecycle.createOrReuseJob.mockResolvedValue(liveForeignRow);

    await runSeoAudit('p1');
    await scanTicks();

    expect(scans.runSeoChecks).toHaveBeenCalledTimes(1);
    expect(lifecycle.createOrReuseJob).not.toHaveBeenCalled();
    expect(credits.consumeCredits).toHaveBeenCalledTimes(1);
  });

  it('charges exactly once with nothing else live, and not twice', async () => {
    await runCodeAudit('p1');
    await scanTicks();

    // There is no second branch left for the charge to skip. The spend was
    // `markJobRunning({ chargeCredits: true })` against a QUEUED row we owned, made
    // idempotent by `creditsChargedAt`; the row went with defect A, so the spend is
    // unconditional and the in-process claim is the only thing keeping it to once per
    // scan. Two debits for one press is what a second `consumeCredits` here would be.
    expect(lifecycle.markJobRunning).not.toHaveBeenCalled();
    expect(credits.consumeCredits).toHaveBeenCalledTimes(1);
    expect(credits.consumeCredits).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'audit',
      'p1',
    );
  });

  it('charges nothing for an auto-kicked scan on either branch', async () => {
    await runAutoCodeAudit('p1', BUILD_ID);
    await scanTicks();

    expect(credits.checkCredits).not.toHaveBeenCalled();
    expect(credits.consumeCredits).not.toHaveBeenCalled();
    expect(lifecycle.markJobRunning).not.toHaveBeenCalled();
  });
});

/* ------------------------- C: the two scans cannot share a row, because neither takes one */

describe('C a code scan and an SEO scan running together stay separable', () => {
  it('shares no row: each files its own settled AUDIT row under its own marker', async () => {
    // The shape the audit described: `createOrReuseJob` hands both callers the same freshly
    // inserted AUDIT row, read before anything stamped it, and each writes its own step over
    // the other's. The two `inflight` maps are per-module and the project lock is re-entrant
    // for one user, so nothing else separated them. What separates them now is that there is
    // no shared row to race over — closing defect A took the live row off both paths — so the
    // fixture below is primed and then asserted never to be read, rather than dropped.
    lifecycle.createOrReuseJob.mockResolvedValue({
      id: 'job_audit_shared',
      kind: 'AUDIT',
      status: 'QUEUED',
      currentStep: null,
    });

    await Promise.all([runCodeAudit('p1'), runSeoAudit('p1')]);
    await scanTicks();

    expect(lifecycle.createOrReuseJob).not.toHaveBeenCalled();
    expect(lifecycle.markJobRunning).not.toHaveBeenCalled();
    expect(store.updateJobFields).not.toHaveBeenCalled();
    expect(store.claimAuditJobStep).not.toHaveBeenCalled();

    // One row each, under its own marker — never one row stamped twice, which is how a
    // failing code scan came to be reported by `getLatestSeoAudit` as an SEO failure while
    // `getLatestCodeAudit` found nothing.
    expect(scans.runCodeScan).toHaveBeenCalledTimes(1);
    expect(scans.runSeoChecks).toHaveBeenCalledTimes(1);
    expect(filedJobs).toHaveLength(2);
    expect(new Set(filedJobs.map((row) => row.currentStep))).toEqual(
      new Set([CODE_AUDIT_STEP, SEO_AUDIT_STEP]),
    );
  });

  it('leaves a live AUDIT row on the project alone rather than adopting it', async () => {
    // A row from another instance, or from a scan this process has forgotten. The kind-blind
    // `getActiveJob` behind `createOrReuseJob` would have handed it straight over; a scan
    // that adopted it would settle a row it never started and stamp its step over whatever
    // that row was already reporting.
    lifecycle.createOrReuseJob.mockResolvedValue({
      id: 'job_audit_seo',
      kind: 'AUDIT',
      status: 'QUEUED',
      currentStep: SEO_AUDIT_STEP,
    });
    stampedSteps.set('job_audit_seo', SEO_AUDIT_STEP);

    await runCodeAudit('p1');
    await scanTicks();

    expect(lifecycle.createOrReuseJob).not.toHaveBeenCalled();
    expect(store.updateJobFields).not.toHaveBeenCalled();
    expect(lifecycle.markJobRunning).not.toHaveBeenCalled();
    expect(lifecycle.succeedJob).not.toHaveBeenCalled();
    // Charged, and filed under its own marker.
    expect(credits.consumeCredits).toHaveBeenCalledTimes(1);
    expect(filedJobs).toEqual([expect.objectContaining({ currentStep: CODE_AUDIT_STEP })]);
  });
});

/* --------------------------------------------------- D: two clicks are one scan */

describe('D two concurrent Scan clicks do not corrupt the scanning flag', () => {
  it('starts one scan and keeps reporting it in flight until that scan ends', async () => {
    const gate = deferred<{ findings: []; metrics: object; signals: object }>();
    scans.runCodeScan.mockReturnValue(gate.promise);

    const results = await Promise.all([runCodeAudit('p1'), runCodeAudit('p1')]);
    // The scan is detached and the gate is still closed, so this only lets it reach
    // `runCodeScan` — the claim is still held for as long as the gate is.
    await scanTicks();

    expect(results.every((result) => result.ok)).toBe(true);
    // Two scans is the defect. The second click's `startDetachedCodeScan`/job chain also
    // owned the map entry, so whichever finished first deleted the other's and the panel
    // stopped showing a scan that was still running.
    expect(scans.runCodeScan).toHaveBeenCalledTimes(1);
    expect(await isCodeScanInFlight('p1')).toMatchObject({
      ok: true,
      data: { inFlight: true },
    });

    gate.resolve({ findings: [], metrics: {}, signals: {} });
    await scanTicks();

    expect(await isCodeScanInFlight('p1')).toMatchObject({
      ok: true,
      data: { inFlight: false },
    });
  });

  it('does not charge the second click, because it starts no second scan', async () => {
    const gate = deferred<{ findings: []; metrics: object; signals: object }>();
    scans.runCodeScan.mockReturnValue(gate.promise);
    lifecycle.createOrReuseJob.mockResolvedValue({
      id: 'job_followup_1',
      kind: 'FOLLOWUP',
      status: 'RUNNING',
      currentStep: 'generate',
    });

    await Promise.all([runCodeAudit('p1'), runCodeAudit('p1')]);
    await scanTicks();

    // One scan, one charge. The detached branch spends directly, so a second click that got
    // past the claim would be a second debit as well as a second AI review.
    expect(scans.runCodeScan).toHaveBeenCalledTimes(1);
    expect(credits.consumeCredits).toHaveBeenCalledTimes(1);

    gate.resolve({ findings: [], metrics: {}, signals: {} });
    await scanTicks();
  });

  it('does the same for two SEO clicks', async () => {
    const results = await Promise.all([runSeoAudit('p1'), runSeoAudit('p1')]);
    await scanTicks();

    expect(results.every((result) => result.ok)).toBe(true);
    expect(scans.runSeoChecks).toHaveBeenCalledTimes(1);
  });
});
