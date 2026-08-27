import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Round 5. Auto-running the quality scans after every build was three separate costs
 * nobody had priced, and this suite pins the answer to each.
 *
 *  A. Unbilled, unrecorded provider spend. The auto path reached `runAiReview`, a
 *     `generateText` carrying up to 40 000 input tokens of the user's source, on every
 *     settled build. Nothing called `recordJobUsage`, `accrueSpend` or
 *     `logGenerationEvent`, so a workspace doing 200 chat turns a day roughly doubled the
 *     operator's provider invoice with no row anywhere explaining the difference — and
 *     because `Workspace.spendUsd` never moved, the 100 %-of-ceiling auto-pause could not
 *     fire on it. The automatic scan no longer makes the call at all, and the manual one
 *     records what it spends.
 *  B. A browser the production image cannot launch. `runA11yAudit` and `runLighthouseSeo`
 *     both go through `withHeadlessBrowser`; `pnpm install --ignore-scripts` skips the
 *     Playwright download, so both threw "Executable does not exist" and filed a tool
 *     failure against every project after every build. Neither runs automatically now.
 *  D. The manual Scan held the project's one live job row. `one_active_job_per_project` is
 *     `UNIQUE ("projectId") WHERE status IN ('QUEUED','RUNNING')` and `getActiveJob` is
 *     kind-blind, so a RUNNING AUDIT row was handed to the generation route's own
 *     `createOrReuseJob({ kind: 'FOLLOWUP' })` and the user's next message came back "A
 *     build is already running on this project" — for a scan they had started themselves.
 *
 * The scan modules are real here on purpose: `runCodeScan` and `performSeoAudit` decide
 * what runs, so stubbing them would move the property under test out of the run. Only the
 * three expensive checks are stubbed, and a stub that is never called is the assertion.
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
// Only what the two actions still reach for. `claimAuditJobStep` and `updateJobFields`
// are absent on purpose: they belonged to the live AUDIT row, and a mock module that
// still offered them would hide a call that came back.
const store = vi.hoisted(() => ({
  insertSettledJob: vi.fn(),
  findRecentlySucceededBuild: vi.fn(),
}));
const lifecycle = vi.hoisted(() => ({
  beginJobHeartbeat: vi.fn(),
  createOrReuseJob: vi.fn(),
  failJob: vi.fn(),
  markJobRunning: vi.fn(),
  succeedJob: vi.fn(),
}));
const consumption = vi.hoisted(() => ({ recordJobUsage: vi.fn() }));
/**
 * The audit's second ledger. `recordScanSpend` writes a `GenerationEvent` as well as the
 * job row now — that table is what every /admin/usage panel aggregates — so leaving the
 * real module in this run made the scan call through to prisma and `maybeSettleFollowups`,
 * which this file does not mock. What that write must contain is pinned in
 * `tests/unit/quality-scan-verdict-and-ledger.test.ts`; here it only has to be a stub.
 */
const usageCosts = vi.hoisted(() => ({ logGenerationEvent: vi.fn(async () => 'event-1') }));
/** The three checks that cost money or fork a browser. Never called is the point. */
const expensive = vi.hoisted(() => ({
  runAiReview: vi.fn(),
  runA11yAudit: vi.fn(),
  runLighthouseSeo: vi.fn(),
}));

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
vi.mock('@/lib/preview/url', () => ({ auditPreviewUrl: vi.fn(async () => 'https://preview/p1') }));
vi.mock('@/lib/seo/scan', () => ({ runSeoChecks: vi.fn(() => []) }));
vi.mock('@/lib/seo/live', () => ({
  fetchPreviewDocument: vi.fn(async () => null),
  fetchPreviewText: vi.fn(async () => null),
}));
vi.mock('@/lib/jobs/store', () => store);
vi.mock('@/lib/jobs/lifecycle', () => lifecycle);
vi.mock('@/lib/consumption/record', () => consumption);
vi.mock('@/lib/usage-costs', () => usageCosts);
// Partial mocks: the needs-a-scan finding builders stay real, because what the panel is
// shown is half of what this suite is about. Only the calls that cost something are stubs.
vi.mock('@/lib/audit/a11y', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit/a11y')>()),
  runA11yAudit: expensive.runA11yAudit,
}));
vi.mock('@/lib/audit/ai-review', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit/ai-review')>()),
  runAiReview: expensive.runAiReview,
}));
vi.mock('@/lib/seo/lighthouse', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/seo/lighthouse')>()),
  runLighthouseSeo: expensive.runLighthouseSeo,
}));

import { getLatestCodeAudit, runAutoCodeAudit, runCodeAudit } from '@/lib/audit/actions';
import { getLatestSeoAudit, runAutoSeoAudit, runSeoAudit } from '@/lib/seo/actions';
import { runCodeScan } from '@/lib/audit/scan';
import { CODE_AUDIT_STEP, SEO_AUDIT_STEP } from '@/lib/audit/poll-state';
import { ACTIVE_JOB_STATUSES } from '@/lib/jobs/types';
import type { CodeFinding } from '@/lib/audit/types';
import type { SeoFinding } from '@/lib/seo/types';

const USER = { id: 'user-1', role: 'MEMBER' };
const PROJECT = { id: 'p1', ownerId: 'user-1', stack: 'NEXTJS', designDirection: null };
const BUILD_ID = 'job_build_1';
const BUILT_AT = new Date(Date.now() - 60_000);
const AUDIT_ROW_ID = 'job_record_1';

/** The scans are detached; give their promise chains a turn before asserting. */
const scanTicks = () => new Promise((resolve) => setTimeout(resolve, 20));

/** The findings the run stored, read off the `CodeAudit` row it wrote. */
function storedCodeFindings(): CodeFinding[] {
  const call = prisma.codeAudit.create.mock.calls[0]?.[0] as
    | { data: { findings: CodeFinding[] } }
    | undefined;
  return call?.data.findings ?? [];
}

function storedSeoFindings(): SeoFinding[] {
  const call = prisma.seoAudit.create.mock.calls[0]?.[0] as
    | { data: { findings: SeoFinding[] } }
    | undefined;
  return call?.data.findings ?? [];
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
  store.insertSettledJob.mockResolvedValue({ id: AUDIT_ROW_ID });
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
  consumption.recordJobUsage.mockResolvedValue(0.02);
  expensive.runA11yAudit.mockResolvedValue([]);
  expensive.runAiReview.mockResolvedValue({ findings: [], usage: null });
  expensive.runLighthouseSeo.mockResolvedValue([]);
});

/* ------------------------------------------------- the static half is separable at all */

describe('runCodeScan splits the free checks from the expensive ones', () => {
  const scanInput = {
    stack: 'NEXTJS' as const,
    files: [],
    previewUrl: 'https://preview/p1',
    sandbox: null,
    seoFindings: [],
    userId: 'user-1',
  };

  it('static depth calls neither the provider nor the browser', async () => {
    const result = await runCodeScan({ ...scanInput, depth: 'static' });

    expect(expensive.runAiReview).not.toHaveBeenCalled();
    expect(expensive.runA11yAudit).not.toHaveBeenCalled();
    expect(result.aiUsage).toBeNull();
  });

  it('static depth still runs the file-level checks, so the scan is worth something', async () => {
    const result = await runCodeScan({ ...scanInput, depth: 'static' });

    // With no build runner these report "could not run" rather than defects, which is the
    // honest answer and the one the panel already renders. The point is that the static
    // pass executed: dropping it as well would leave the automatic scan doing nothing.
    expect(result.findings.some((row) => row.id === 'tool:typescript')).toBe(true);
    expect(result.findings.some((row) => row.id === 'tool:lint')).toBe(true);
  });

  it('static depth says which checks are waiting, instead of showing a partial audit', async () => {
    const result = await runCodeScan({ ...scanInput, depth: 'static' });

    const deferred = result.findings.filter((row) => row.id.endsWith(':needs-scan'));
    expect(deferred.map((row) => row.id).sort()).toEqual([
      'tool:a11y:needs-scan',
      'tool:ai-review:needs-scan',
    ]);
    // Not a defect the model can act on: there is nothing wrong with the code.
    expect(deferred.every((row) => row.fixable === false)).toBe(true);
    // And not hidden among the passes either — a reader has to see them.
    expect(deferred.every((row) => row.status !== 'pass')).toBe(true);
  });

  it('asserts nothing about accessibility when axe did not run', async () => {
    const result = await runCodeScan({ ...scanInput, depth: 'static' });

    // `null` is what makes `recordCodeAuditSignals` write no `a11y_score`. Zero
    // violations from a check that never started is indistinguishable from a clean
    // page, and recording it as 1.0 is how "never executed" became "perfect" (F-705).
    expect(result.signals.axeViolations).toBeNull();
  });

  it('full depth runs both, and hands back what the AI review spent', async () => {
    expensive.runAiReview.mockResolvedValue({
      findings: [],
      usage: { tokensIn: 38_000, tokensOut: 900, calls: 1, estimatedCalls: 0, provider: null, model: 'deepseek-v4-flash' },
    });

    const result = await runCodeScan({ ...scanInput, depth: 'full' });

    expect(expensive.runA11yAudit).toHaveBeenCalledTimes(1);
    expect(expensive.runAiReview).toHaveBeenCalledTimes(1);
    expect(result.aiUsage).toMatchObject({ tokensIn: 38_000, tokensOut: 900 });
    expect(result.findings.some((row) => row.id.endsWith(':needs-scan'))).toBe(false);
  });

  it('defaults to the full audit, so a new caller opts out rather than in', async () => {
    await runCodeScan(scanInput);

    expect(expensive.runA11yAudit).toHaveBeenCalledTimes(1);
    expect(expensive.runAiReview).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------- A + B: the automatic scan costs nothing */

describe('an auto-kicked scan calls no provider and launches no browser', () => {
  it('runs the code scan without reaching runAiReview or runA11yAudit', async () => {
    await runAutoCodeAudit('p1', BUILD_ID);
    await scanTicks();

    // The settled AUDIT row is what proves the scan ran. It used to be the `CodeAudit`
    // row, which this deployment no longer writes: with `sandbox = null` every static
    // check reports that it could not run, and a row whose entire content is six of those
    // rendered on the Quality panel as a completed audit with a clean scorecard. See
    // `tests/unit/quality-scan-verdict-and-ledger.test.ts`.
    expect(store.insertSettledJob).toHaveBeenCalledTimes(1);
    expect(expensive.runAiReview).not.toHaveBeenCalled();
    expect(expensive.runA11yAudit).not.toHaveBeenCalled();
  });

  it('runs the SEO scan without reaching Lighthouse', async () => {
    await runAutoSeoAudit('p1', BUILD_ID);
    await scanTicks();

    expect(prisma.seoAudit.create).toHaveBeenCalledTimes(1);
    expect(expensive.runLighthouseSeo).not.toHaveBeenCalled();
  });

  it('records no spend, because it spent nothing', async () => {
    await runAutoCodeAudit('p1', BUILD_ID);
    await scanTicks();

    expect(consumption.recordJobUsage).not.toHaveBeenCalled();
  });

  it('stores the SEO row that names the check still waiting for a Scan, and no code row', async () => {
    await runAutoCodeAudit('p1', BUILD_ID);
    await scanTicks();
    await runAutoSeoAudit('p1', BUILD_ID);
    await scanTicks();

    // The two halves are no longer symmetric, and that asymmetry is the fix. `runSeoChecks`
    // reads the files and the live document, so the SEO scan reaches real verdicts with no
    // build runner and writes its row — announcing Lighthouse as still waiting. Every
    // static code check needs a runner this instance does not have, so the code scan
    // reaches a verdict about nothing and stores no row at all rather than six "could not
    // run" rows over a scorecard of zeros. The deferred rows themselves are still produced
    // — pinned by `static depth says which checks are waiting` above — and are stored again
    // as soon as any check reaches a verdict; see
    // `tests/unit/quality-scan-verdict-and-ledger.test.ts`.
    expect(storedCodeFindings()).toEqual([]);
    const lighthouse = storedSeoFindings().find((row) => row.id === 'lighthouse:needs-scan');
    expect(lighthouse).toBeDefined();
    // `info` is "we could not evaluate this": the SEO panel groups it under Not checked
    // and the score leaves it out, so an unrun check cannot read as a clean one.
    expect(lighthouse?.status).toBe('info');
    expect(lighthouse?.fixable).toBe(false);
  });
});

/* ---------------------------------- A: a provider call that happens is a call recorded */

describe('the manual Scan records what its AI review spends', () => {
  const USAGE = {
    tokensIn: 39_000,
    tokensOut: 1_200,
    calls: 1,
    estimatedCalls: 0,
    provider: null,
    model: 'deepseek-v4-flash',
  };

  it('runs the full audit and writes the tokens onto the AUDIT row it files', async () => {
    expensive.runAiReview.mockResolvedValue({ findings: [], usage: USAGE });

    await runCodeAudit('p1');
    await scanTicks();

    expect(expensive.runAiReview).toHaveBeenCalledTimes(1);
    expect(expensive.runA11yAudit).toHaveBeenCalledTimes(1);
    // `recordJobUsage` is the writer a generation uses: it stamps the job row and then
    // calls `accrueSpend`, which is what moves `Workspace.spendUsd` and what the
    // 100 %-of-ceiling auto-pause reads. Being free to the user never meant being
    // invisible to the operator.
    expect(consumption.recordJobUsage).toHaveBeenCalledTimes(1);
    expect(consumption.recordJobUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: AUDIT_ROW_ID,
        tokensIn: 39_000,
        tokensOut: 1_200,
        model: 'deepseek-v4-flash',
      }),
    );
  });

  it('still records the spend when the scan died after the model answered', async () => {
    expensive.runAiReview.mockResolvedValue({ findings: [], usage: USAGE });
    prisma.codeAudit.create.mockRejectedValue(new Error('storage write failed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runCodeAudit('p1');
    await scanTicks();

    // Tokens that have already left do not become unspent because the row describing
    // them failed to save.
    expect(consumption.recordJobUsage).toHaveBeenCalledWith(
      expect.objectContaining({ tokensIn: 39_000 }),
    );
    warn.mockRestore();
  });

  it('records nothing when the review made no call', async () => {
    expensive.runAiReview.mockResolvedValue({ findings: [], usage: null });

    await runCodeAudit('p1');
    await scanTicks();

    expect(consumption.recordJobUsage).not.toHaveBeenCalled();
  });
});

/* ------------------------------------ D: the Scan button does not take the build's slot */

describe('a manual Scan leaves the project free for the next message', () => {
  it('creates no job row and marks none running', async () => {
    await runCodeAudit('p1');
    await scanTicks();

    // These two are the only ways a row enters QUEUED/RUNNING, which is the state
    // `one_active_job_per_project` bounds and the state `getActiveJob` — and therefore
    // the refusal the user reads, and `isChatBuilding`'s locked input — looks at.
    expect(lifecycle.createOrReuseJob).not.toHaveBeenCalled();
    expect(lifecycle.markJobRunning).not.toHaveBeenCalled();
    expect(lifecycle.beginJobHeartbeat).not.toHaveBeenCalled();
  });

  it('does the same for the SEO Scan button', async () => {
    await runSeoAudit('p1');
    await scanTicks();

    expect(lifecycle.createOrReuseJob).not.toHaveBeenCalled();
    expect(lifecycle.markJobRunning).not.toHaveBeenCalled();
  });

  it('files a terminal AUDIT row instead, so /admin/jobs still sees the scan', async () => {
    await runCodeAudit('p1');
    await scanTicks();

    const filed = store.insertSettledJob.mock.calls[0][0] as {
      kind: string;
      status: string;
      currentStep: string;
    };
    expect(filed.kind).toBe('AUDIT');
    expect(filed.currentStep).toBe(CODE_AUDIT_STEP);
    expect(ACTIVE_JOB_STATUSES).not.toContain(filed.status);
  });

  it('keeps the metering: one credit checked and one spent per scan', async () => {
    await runCodeAudit('p1');
    await scanTicks();

    expect(credits.checkCredits).toHaveBeenCalledWith(expect.anything(), 'user-1', 'audit');
    expect(credits.consumeCredits).toHaveBeenCalledTimes(1);
    expect(credits.consumeCredits).toHaveBeenCalledWith(expect.anything(), 'user-1', 'audit', 'p1');
  });

  it('charges once for two clicks, because the second starts no second scan', async () => {
    await Promise.all([runCodeAudit('p1'), runCodeAudit('p1')]);
    await scanTicks();

    expect(credits.consumeCredits).toHaveBeenCalledTimes(1);
    expect(prisma.codeAudit.create).toHaveBeenCalledTimes(1);
  });

  it('a failing manual scan still reaches the panel through its own row', async () => {
    prisma.codeAudit.create.mockRejectedValue(new Error('storage write failed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runCodeAudit('p1');
    await scanTicks();

    const filed = store.insertSettledJob.mock.calls[0][0] as {
      status: string;
      errorMessage: string;
      currentStep: string;
    };
    expect(filed.status).toBe('FAILED');
    expect(filed.errorMessage).toBe('storage write failed');
    expect(filed.currentStep).toBe(CODE_AUDIT_STEP);

    // And the poll reads it back under the same marker.
    prisma.job.findFirst.mockResolvedValue({
      errorMessage: 'storage write failed',
      finishedAt: new Date(),
      createdAt: new Date(),
    });
    const polled = await getLatestCodeAudit('p1');
    expect(polled.ok).toBe(true);
    if (!polled.ok) throw new Error('unreachable');
    expect(polled.data.lastError).toBe('storage write failed');
    warn.mockRestore();
  });

  it('the SEO scan files its own row under its own marker', async () => {
    await runSeoAudit('p1');
    await scanTicks();

    const filed = store.insertSettledJob.mock.calls[0][0] as { currentStep: string };
    expect(filed.currentStep).toBe(SEO_AUDIT_STEP);

    const polled = await getLatestSeoAudit('p1');
    expect(polled.ok).toBe(true);
  });
});
