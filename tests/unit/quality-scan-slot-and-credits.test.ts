import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The three defects the auto-kicked quality scans shipped with.
 *
 *  A. The scan took the project's only job slot. `one_active_job_per_project` is a
 *     partial UNIQUE index over ("projectId") WHERE status IN ('QUEUED','RUNNING'), and
 *     `createOrReuseJob` resolves contention through the kind-blind `getActiveJob` — so
 *     an AUDIT row left RUNNING for the length of an AI review is handed to the next
 *     caller. A build finished, the scan started, and "make the header blue" came back
 *     with "A build is already running on this project, so your message was not sent."
 *     The automatic build-fix loop got the same refusal and reported "The automatic
 *     build fix produced no changes".
 *  B. Every build spent an audit credit nobody asked for
 *     (`markJobRunning({ chargeCredits: true })`), so a plan allowing 20 audits a month
 *     was empty after 20 chat turns and the user's own Scan button then failed with
 *     "credits used up".
 *  C. The code scan and the SEO scan shared one job row, because the second to start
 *     adopted the first's. The adopter replaced `currentStep` and `steps` wholesale, so
 *     `getLatestCodeAudit` (which queries `currentStep: CODE_AUDIT_STEP`) found nothing
 *     for a code scan that had failed while `getLatestSeoAudit` reported that same
 *     failure as an SEO one.
 *
 * The manual Scan button is asserted here too, and half of what this file used to say
 * about it has since changed. It still takes the project lock, still checks an audit
 * credit and still spends one. It no longer holds a live AUDIT row: defect A was
 * reachable from the button as well, because `one_active_job_per_project` makes any
 * QUEUED/RUNNING row the project's build slot whatever its kind, so a user who pressed
 * Scan and then typed a message was told a build was already running. Visibility did not
 * go with it — `recordScanRun` files a settled AUDIT row carrying the same
 * `CODE_AUDIT_STEP` marker when the scan ends, which is what /admin/jobs and
 * `getLatestCodeAudit` read.
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
// `consumeCredits` is where the manual Scan's charge lives now: it used to happen only
// inside `markJobRunning({ chargeCredits: true })`, which required owning a QUEUED row, so
// the scan ran free on every branch that did not get one. `updateJobFields` and
// `claimAuditJobStep` are the opposite — they belonged to the live AUDIT row and no scan
// reaches either any more. They stay declared so the assertions below can name them: a
// call that came back would otherwise be a scan holding the build slot again, which is
// defect A returning. See `tests/unit/quality-scan-warrant-and-metering.test.ts` for the
// concurrency guards around the same seams.
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

import { runAutoCodeAudit, runCodeAudit } from '@/lib/audit/actions';
import { runAutoSeoAudit } from '@/lib/seo/actions';
import { CODE_AUDIT_STEP, SEO_AUDIT_STEP } from '@/lib/audit/poll-state';
import { ACTIVE_JOB_STATUSES } from '@/lib/jobs/types';

const USER = { id: 'user-1', role: 'MEMBER' };
/** `performCodeAudit` / `performSeoAudit` read `stack` off this row, so it has to be real. */
const PROJECT = { id: 'p1', ownerId: 'user-1', stack: 'NEXTJS', designDirection: null };
const BUILD_ID = 'job_build_1';
const BUILT_AT = new Date('2026-08-25T10:00:00.000Z');

/** The scan is detached; give its promise chain a turn before asserting. */
const scanTicks = () => new Promise((resolve) => setTimeout(resolve, 20));

type SettledJobCall = {
  kind: string;
  status: string;
  currentStep: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  userId: string;
  steps: Array<{ key: string; status: string; error: string | null }>;
};

function settledJobCalls(): SettledJobCall[] {
  return store.insertSettledJob.mock.calls.map((call) => call[0] as SettledJobCall);
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.getSessionUser.mockResolvedValue(USER);
  prisma.project.findFirst.mockResolvedValue(PROJECT);
  prisma.job.findFirst.mockResolvedValue(null);
  prisma.codeAudit.findFirst.mockResolvedValue(null);
  prisma.seoAudit.findFirst.mockResolvedValue(null);
  prisma.codeAudit.create.mockResolvedValue({ id: 'audit-1' });
  prisma.seoAudit.create.mockResolvedValue({ id: 'seo-1' });
  publishFiles.projectHasPublishableFiles.mockResolvedValue({ status: 'ready' });
  lock.holdProjectLock.mockResolvedValue({ ok: true, release: vi.fn(async () => undefined) });
  credits.checkCredits.mockResolvedValue({ ok: true });
  credits.consumeCredits.mockResolvedValue(undefined);
  store.insertSettledJob.mockResolvedValue({ id: 'job_record_1' });
  store.updateJobFields.mockResolvedValue(null);
  store.claimAuditJobStep.mockResolvedValue(true);
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

/* --------------------------------------------------- A: the build's slot stays free */

describe('an auto-kicked scan takes nothing a build competes for', () => {
  it('creates no job row and starts none running', async () => {
    const result = await runAutoCodeAudit('p1', BUILD_ID);
    await scanTicks();

    expect(result).toMatchObject({ ok: true, data: { scanning: true } });
    // Both of these are how a row enters QUEUED/RUNNING, which is the only state
    // `getActiveJob` — and therefore the refusal the user reads — looks at.
    expect(lifecycle.createOrReuseJob).not.toHaveBeenCalled();
    expect(lifecycle.markJobRunning).not.toHaveBeenCalled();
  });

  it('files a row that is terminal from its first statement', async () => {
    await runAutoCodeAudit('p1', BUILD_ID);
    await scanTicks();

    const recorded = settledJobCalls();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].kind).toBe('AUDIT');
    // The whole point: `one_active_job_per_project` and `getActiveJob` both key on
    // QUEUED/RUNNING, so a row written straight to a terminal status cannot hold the
    // slot the user's next message needs.
    expect(ACTIVE_JOB_STATUSES).not.toContain(recorded[0].status);
    expect(recorded[0].status).toBe('SUCCEEDED');
  });

  it('does not take the project lock', async () => {
    await runAutoCodeAudit('p1', BUILD_ID);
    await scanTicks();

    // `acquireLock` is re-entrant for one user, so a scan holding the lock would be
    // released out from under a build the same person started meanwhile (NAV-03), and
    // for anyone else on the project it is a straight block.
    expect(lock.holdProjectLock).not.toHaveBeenCalled();
  });

  it('refuses a job id that is not a build of this project that recently succeeded', async () => {
    store.findRecentlySucceededBuild.mockResolvedValue(null);

    const result = await runAutoCodeAudit('p1', 'job_not_mine');
    await scanTicks();

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(store.insertSettledJob).not.toHaveBeenCalled();
    expect(scans.runCodeScan).not.toHaveBeenCalled();
  });

  it('runs once per build: a replayed job id buys no second AI review', async () => {
    prisma.codeAudit.findFirst.mockResolvedValue({
      id: 'audit-0',
      projectId: 'p1',
      findings: [],
      metrics: {},
      scannedAt: new Date(BUILT_AT.getTime() + 1000),
    });

    const result = await runAutoCodeAudit('p1', BUILD_ID);
    await scanTicks();

    expect(result).toMatchObject({ ok: true, data: { scanning: false } });
    expect(scans.runCodeScan).not.toHaveBeenCalled();
  });
});

/* ----------------------------------------------------------- B: whose credit is it */

describe('credits are spent only on a scan the user asked for', () => {
  it('an auto-kicked scan checks no credit and charges none', async () => {
    await runAutoCodeAudit('p1', BUILD_ID);
    await scanTicks();

    expect(credits.checkCredits).not.toHaveBeenCalled();
    expect(lifecycle.markJobRunning).not.toHaveBeenCalled();
  });

  it('the Scan button still checks a credit and still charges it', async () => {
    await runCodeAudit('p1');
    await scanTicks();

    expect(credits.checkCredits).toHaveBeenCalledWith(expect.anything(), 'user-1', 'audit');
    // `checkCredits` only reads the balance. The spend used to live inside
    // `markJobRunning({ chargeCredits: true })`, which the scan reached only while it
    // owned a QUEUED row — so removing the row removed the charge with it unless the
    // charge moved. It moved here, guarded once per scan by the in-process claim.
    expect(credits.consumeCredits).toHaveBeenCalledTimes(1);
    expect(credits.consumeCredits).toHaveBeenCalledWith(expect.anything(), 'user-1', 'audit', 'p1');
    // And it takes no job row on the way: `one_active_job_per_project` is kind-blind, so a
    // QUEUED or RUNNING AUDIT row is the project's build slot and the user's next message
    // is refused for the length of the scan. That is defect A, reached from the button.
    expect(lifecycle.createOrReuseJob).not.toHaveBeenCalled();
    expect(lifecycle.markJobRunning).not.toHaveBeenCalled();
    expect(store.updateJobFields).not.toHaveBeenCalled();
    expect(store.claimAuditJobStep).not.toHaveBeenCalled();
    // Visibility is unchanged in substance, only in timing: the row is written when the
    // scan ends instead of being held open while it runs, and it carries the same step
    // marker `getLatestCodeAudit` and /admin/jobs read.
    expect(settledJobCalls()[0]).toMatchObject({
      kind: 'AUDIT',
      status: 'SUCCEEDED',
      currentStep: CODE_AUDIT_STEP,
      userId: 'user-1',
    });
  });
});

/* -------------------------------------------------- C: one scan cannot mask another */

describe('the code scan and the SEO scan cannot overwrite each other', () => {
  it('a failing code scan is readable as a code-scan failure and never as an SEO one', async () => {
    scans.runCodeScan.mockRejectedValue(new Error('AI review provider error'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runAutoCodeAudit('p1', BUILD_ID);
    await scanTicks();
    await runAutoSeoAudit('p1', BUILD_ID);
    await scanTicks();

    const recorded = settledJobCalls();
    expect(recorded).toHaveLength(2);

    const code = recorded.find((row) => row.currentStep === CODE_AUDIT_STEP);
    const seo = recorded.find((row) => row.currentStep === SEO_AUDIT_STEP);
    // Two rows, not one adopted twice: `getLatestCodeAudit` reads the first through its
    // `currentStep: CODE_AUDIT_STEP` filter and `getLatestSeoAudit` reads the second.
    expect(code).toBeDefined();
    expect(seo).toBeDefined();
    expect(code?.status).toBe('FAILED');
    expect(code?.errorMessage).toBe('AI review provider error');
    expect(code?.steps[0]).toMatchObject({ key: CODE_AUDIT_STEP, status: 'failed' });

    // The SEO scan succeeded, and nothing about the code failure leaked onto its row.
    expect(seo?.status).toBe('SUCCEEDED');
    expect(seo?.errorMessage).toBeNull();
    expect(seo?.steps[0]).toMatchObject({ key: SEO_AUDIT_STEP, error: null });
    warn.mockRestore();
  });

  it('a deleted project is filed as project_deleted, not as an AI-provider miss', async () => {
    prisma.project.findFirst
      .mockResolvedValueOnce(PROJECT) // the ownership read in runAutoCodeAudit
      .mockResolvedValueOnce(null); // gone by the time the detached scan looks

    await runAutoCodeAudit('p1', BUILD_ID);
    await scanTicks();

    const recorded = settledJobCalls();
    expect(recorded[0]).toMatchObject({ status: 'FAILED', errorCode: 'project_deleted' });
    expect(recorded[0].currentStep).toBe(CODE_AUDIT_STEP);
  });

  it('the Scan button never stamps its step over a job row that is not its own', async () => {
    // The exact adoption `createOrReuseJob` performs: the project already has a live
    // FOLLOWUP, so the kind-blind `getActiveJob` hands it back. Writing our step over it
    // replaced the build's `steps`, and `succeedJob` at the end of the scan would have
    // settled a build that was still streaming.
    lifecycle.createOrReuseJob.mockResolvedValue({
      id: 'job_followup_1',
      kind: 'FOLLOWUP',
      status: 'RUNNING',
      currentStep: 'generate',
    });

    const result = await runCodeAudit('p1');
    await scanTicks();

    expect(result).toMatchObject({ ok: true, data: { scanning: true } });
    expect(store.updateJobFields).not.toHaveBeenCalled();
    expect(lifecycle.markJobRunning).not.toHaveBeenCalled();
    expect(lifecycle.succeedJob).not.toHaveBeenCalled();
    // The scan still happened, and still left a record of its own.
    expect(scans.runCodeScan).toHaveBeenCalledTimes(1);
    expect(settledJobCalls()[0]).toMatchObject({ kind: 'AUDIT', currentStep: CODE_AUDIT_STEP });
  });

  it('the Scan button hands its lock back when it falls through to the detached path', async () => {
    const release = vi.fn(async () => undefined);
    lock.holdProjectLock.mockResolvedValue({ ok: true, release });
    lifecycle.createOrReuseJob.mockResolvedValue({
      id: 'job_followup_1',
      kind: 'FOLLOWUP',
      status: 'RUNNING',
      currentStep: 'generate',
    });

    await runCodeAudit('p1');
    await scanTicks();

    expect(release).toHaveBeenCalled();
  });
});
