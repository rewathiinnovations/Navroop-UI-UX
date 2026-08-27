import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Round 6, found by driving the real app rather than by the suite.
 *
 * A. THE AUTOMATIC SCAN PRODUCED A VERDICT NOBODY REACHED. Round 5 correctly cut the
 *    post-build scan down to the static half, so it stopped making a paid provider call
 *    and forking a Chromium on every build. But `performCodeAudit` passes `sandbox = null`
 *    unconditionally, so all four static checks short-circuit into `tool:<check>` rows and
 *    `runBundleMeasure` returns `ran: false`. The `CodeAudit` row written after a real
 *    build therefore contained, in full: six findings, every one category `tool`, every one
 *    saying a check could not run — over a metrics object reading zero errors across the
 *    board, which the Quality panel renders as a completed audit with a clean scorecard.
 *    The same rows were then counted once per project per build by `groupRecurringIssues`,
 *    so the operator's "top recurring issues in generated code" panel on /admin/quality and
 *    /admin/usage filled with the absence of a build runner in the Navroop container and
 *    pushed the real categories out of the top slice.
 *
 *    Two fixes, because the two failures are independent. `performCodeAudit` writes no row
 *    when `checksRun` is zero — the panel's empty state is honest and a scorecard is not —
 *    and `groupRecurringIssues` drops the `tool` category on *read*, because the audits
 *    already stored carry those rows and no change to the scan reaches them. The automatic
 *    scan itself is deliberately still made: having no runner is a property of this
 *    deployment, not of the code, and `checksRun` starts counting the moment one exists.
 *
 * B. THE AI REVIEW'S SPEND REACHED TWO LEDGERS OF THREE. `recordJobUsage` puts the tokens
 *    on the AUDIT row and accrues into `Workspace.spendUsd`, which is what the documented
 *    100 %-of-ceiling auto-pause reads. Every /admin/usage panel is fed by `GenerationEvent`
 *    and nothing else, so an operator running fifty manual Scans a day saw the ceiling move
 *    and the usage dashboard report no AI spend for audits at all. `recordScanSpend` writes
 *    both now.
 *
 * The scan modules are real here on purpose — `runCodeScan` is what decides whether a check
 * reached a verdict, so stubbing it would move the property under test out of the run. Only
 * the two checks that cost money or fork a browser are stubs.
 */

const prisma = vi.hoisted(() => ({
  project: { findFirst: vi.fn() },
  codeAudit: { findFirst: vi.fn(), create: vi.fn() },
  seoAudit: { findFirst: vi.fn() },
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
}));
const signals = vi.hoisted(() => ({ recordCodeAuditSignals: vi.fn(), recordSeoScore: vi.fn() }));
/** The AUDIT job row's ledger: tokens on the row, and the spend-ceiling accrual. */
const consumption = vi.hoisted(() => ({ recordJobUsage: vi.fn() }));
/** The /admin/usage ledger — the one the audit never wrote to. */
const usageCosts = vi.hoisted(() => ({ logGenerationEvent: vi.fn() }));
/** The two checks that cost money or fork a browser. */
const expensive = vi.hoisted(() => ({ runAiReview: vi.fn(), runA11yAudit: vi.fn() }));

vi.mock('@/lib/db', () => ({ prisma }));
vi.mock('@/lib/auth', () => ({ getSessionUser: auth.getSessionUser }));
vi.mock('@/lib/projects/plan', () => ({ peekActor: () => null }));
vi.mock('@/lib/checkpoints/snapshot', () => ({ captureFileSnapshot: vi.fn(async () => []) }));
vi.mock('@/lib/signals/collect', () => signals);
vi.mock('@/lib/publish/files', () => publishFiles);
vi.mock('@/lib/projects/lock', () => ({ holdProjectLock: lock.holdProjectLock }));
vi.mock('@/lib/plans/limits', () => credits);
vi.mock('@/lib/preview/url', () => ({ auditPreviewUrl: vi.fn(async () => 'https://preview/p1') }));
vi.mock('@/lib/jobs/store', () => store);
vi.mock('@/lib/consumption/record', () => consumption);
vi.mock('@/lib/usage-costs', () => usageCosts);
// Partial mocks: the finding builders stay real, so the ids and copy asserted below are the
// ones the product ships rather than strings copied into a fixture.
vi.mock('@/lib/audit/a11y', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit/a11y')>()),
  runA11yAudit: expensive.runA11yAudit,
}));
vi.mock('@/lib/audit/ai-review', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit/ai-review')>()),
  runAiReview: expensive.runAiReview,
}));

import {
  getLatestCodeAudit,
  isCodeScanInFlight,
  runAutoCodeAudit,
  runCodeAudit,
} from '@/lib/audit/actions';
import { groupRecurringIssues } from '@/lib/audit/recurring';
import { runCodeScan } from '@/lib/audit/scan';
import { runStaticAnalysis } from '@/lib/audit/static';
import { finding } from '@/lib/audit/findings';
import { toolFailedFinding } from '@/lib/audit/static/tool-fail';
import { CODE_AUDIT_STEP } from '@/lib/audit/poll-state';
import type { CodeFinding, SandboxRunner } from '@/lib/audit/types';

const USER = { id: 'user-1', role: 'MEMBER' };
const PROJECT = { id: 'p1', ownerId: 'user-1', stack: 'NEXTJS', designDirection: null };
const BUILD_ID = 'job_build_1';
const BUILT_AT = new Date(Date.now() - 60_000);
const AUDIT_ROW_ID = 'job_record_1';

/** What `insertSettledJob` was handed once the detached chain filed its outcome. */
type FiledRow = {
  status: string;
  currentStep: string;
  errorCode: string | null;
  errorMessage: string | null;
  steps: Array<{ label: string }>;
};

/**
 * Wait for the detached scan to be completely over, and hand back the row it filed.
 *
 * Both conditions, not just the row: `recordScanSpend` runs after `insertSettledJob` and
 * the in-process claim is given back after that, so asserting on the row alone can read
 * `scanning: true` from `getLatestCodeAudit` and leave the claim held into the next test —
 * where the second `runCodeAudit` returns early and charges nothing.
 */
async function scanSettled(): Promise<FiledRow> {
  await vi.waitFor(async () => {
    expect(store.insertSettledJob).toHaveBeenCalled();
    const state = await isCodeScanInFlight('p1');
    expect(state.ok && state.data.inFlight).toBe(false);
  });
  return store.insertSettledJob.mock.calls[0][0] as FiledRow;
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.getSessionUser.mockResolvedValue(USER);
  prisma.project.findFirst.mockResolvedValue(PROJECT);
  prisma.job.findFirst.mockResolvedValue(null);
  prisma.codeAudit.findFirst.mockResolvedValue(null);
  prisma.codeAudit.create.mockResolvedValue({ id: 'audit-1' });
  prisma.seoAudit.findFirst.mockResolvedValue(null);
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
  consumption.recordJobUsage.mockResolvedValue(0.02);
  usageCosts.logGenerationEvent.mockResolvedValue('event-1');
  // The default here is the deployment the live run was done on: no build runner, no
  // browser worth the name and no reachable provider, so even a `full` scan reaches a
  // verdict about nothing. Individual tests override.
  expensive.runA11yAudit.mockResolvedValue([toolFailedFinding('a11y', new Error('no browser'))]);
  expensive.runAiReview.mockResolvedValue({
    findings: [toolFailedFinding('ai-review', new Error('no provider'))],
    usage: null,
  });
});

/* ------------------------------------------ A: the platform is not a finding about code */

describe('groupRecurringIssues reports the generated code, not the installation', () => {
  /** One audit exactly as the live run stored it: six rows, every one category `tool`. */
  function nothingRanAudit(): { findings: CodeFinding[] } {
    return {
      findings: [
        toolFailedFinding('typescript', new Error('no build runner on this instance')),
        toolFailedFinding('lint', new Error('no build runner on this instance')),
        toolFailedFinding('dependencies', new Error('no build runner on this instance')),
        toolFailedFinding('dead-code', new Error('no build runner on this instance')),
        finding({
          id: 'tool:a11y:needs-scan',
          category: 'tool',
          status: 'low',
          title: 'Accessibility check not run yet',
          detail: 'Press Scan.',
        }),
        finding({
          id: 'tool:ai-review:needs-scan',
          category: 'tool',
          status: 'low',
          title: 'AI code review not run yet',
          detail: 'Press Scan.',
        }),
      ],
    };
  }

  function realIssue(category: CodeFinding['category'], id: string): { findings: CodeFinding[] } {
    return {
      findings: [
        finding({ id, category, status: 'medium', title: `${category} issue`, detail: '' }),
      ],
    };
  }

  it('counts none of the six rows an audit that could check nothing leaves behind', () => {
    expect(groupRecurringIssues([nothingRanAudit()])).toEqual([]);
  });

  it('cannot be outvoted by the installation, however many builds have run', () => {
    // The live shape: one project's worth of real findings against a day of automatic scans
    // on a container with no build runner. Unfiltered, `tool` wins 120 to 2 — and the panel,
    // whose whole purpose is deciding what the generation prompts should teach the model,
    // then reports a fact no prompt change can ever move.
    const audits = [
      ...Array.from({ length: 20 }, nothingRanAudit),
      realIssue('a11y', 'a11y:button-name'),
      realIssue('ai-review', 'ai-review:app/page.tsx:0:Unbounded state'),
    ];

    const top = groupRecurringIssues(audits);

    expect(top.map((row) => row.category)).toEqual(['a11y', 'ai-review']);
    expect(top.every((row) => row.count === 1)).toBe(true);
  });

  it('filters on read, so the audits already in the table stop polluting the panel too', () => {
    // `getTopRecurringIssues` reads the 200 most recent `CodeAudit` rows straight out of
    // Postgres. A scan that stops writing `tool` findings today does nothing about the ones
    // already stored, so the exclusion cannot live at the write. Round-tripped through JSON
    // because that is how these rows come back — and `asCodeFindings` has to accept them.
    const stored = [
      { findings: JSON.parse(JSON.stringify(nothingRanAudit().findings)) as unknown },
    ];

    expect(groupRecurringIssues(stored)).toEqual([]);
  });

  it('still ignores passes and ignored rows, and still counts everything else', () => {
    const audits = [
      {
        findings: [
          finding({
            id: 'typescript:a.ts:1:TS2322',
            category: 'typescript',
            status: 'high',
            title: 'TS2322',
            detail: '',
          }),
          finding({
            id: 'lint:b.ts:2',
            category: 'lint',
            status: 'medium',
            title: 'no-unused-vars',
            detail: '',
          }),
          finding({
            id: 'bundle:total-js',
            category: 'bundle',
            status: 'medium',
            title: 'Total JS',
            detail: '',
            ignored: true,
          }),
          finding({
            id: 'dead-code:file:c.ts',
            category: 'dead-code',
            status: 'pass',
            title: 'clean',
            detail: '',
          }),
        ] satisfies CodeFinding[],
      },
    ];

    expect(groupRecurringIssues(audits).map((row) => row.category)).toEqual(['lint', 'typescript']);
  });
});

/* ------------------------------ A: "no findings" and "no checks" are not the same reading */

describe('runCodeScan counts verdicts rather than findings', () => {
  const scanInput = {
    stack: 'NEXTJS' as const,
    files: [],
    previewUrl: 'https://preview/p1',
    seoFindings: [],
    userId: 'user-1',
    depth: 'static' as const,
  };

  it('reports zero when every check reported that it could not run', async () => {
    const result = await runCodeScan({ ...scanInput, sandbox: null });

    // Counting findings cannot tell this run apart from a flawless project — both are zero
    // defects — which is how six "could not run" rows came to be stored under a scorecard.
    expect(result.checksRun).toBe(0);
    expect(result.findings.every((row) => row.category === 'tool')).toBe(true);
    expect(result.metrics.tsErrors).toBe(0);
    // …and nothing is asserted about the checks that never started (F-705, F-816).
    expect(result.signals.tsErrors).toBeNull();
    expect(result.signals.buildOk).toBeNull();
    expect(result.signals.axeViolations).toBeNull();
  });

  it('starts counting again the moment a build runner exists, with nothing here to change', async () => {
    // This is why the automatic scan is still made rather than switched off. A runner that
    // answers cleanly means five checks reached a verdict about the project — the four
    // static ones and the bundle measure — and `performCodeAudit` stores the row again.
    const clean = { stdout: '{}', stderr: '', exitCode: 0, success: true };
    const sandbox: SandboxRunner = { runCommand: vi.fn(async () => clean) };

    const result = await runCodeScan({ ...scanInput, sandbox });

    expect(result.checksRun).toBe(5);
    // Not one `tool:<check>` failure row left. The only two rows a clean static run still
    // carries are the pair that names the checks the Scan button owns — those are
    // `:needs-scan` ids on purpose, so `toolFailed` (which means "ran and failed") answers
    // false for them and they do not suppress the count.
    expect(result.findings.map((row) => row.id).sort()).toEqual([
      'tool:a11y:needs-scan',
      'tool:ai-review:needs-scan',
    ]);
    expect(result.signals.tsErrors).toBe(0);
    expect(result.signals.buildOk).toBe(true);
  });
});

/* ----------- A: the one condition `checksWithVerdict` copies, pinned so it cannot drift */

/**
 * `checksWithVerdict` infers "this check ran" from the *absence* of its `tool:<check>` row,
 * which holds only while every check that could not run files one. `STATIC_HTML` is the hole
 * in that: `runStaticAnalysis` dispatches nothing for it, so all four rows are absent for the
 * opposite reason, and a plain count would read four verdicts about a project nobody looked
 * at — the same all-`tool` scorecard defect A is about, arriving through the stack instead of
 * through the missing runner. `lib/audit/scan.ts` keeps its own copy of `skipNode` to close
 * that, and a copied condition is worth only as much as the test that catches it drifting.
 */
describe('a stack whose static checks are never dispatched reaches no verdict either', () => {
  const staticHtmlInput = {
    stack: 'STATIC_HTML' as const,
    files: [],
    previewUrl: 'https://preview/p1',
    seoFindings: [],
    userId: 'user-1',
    depth: 'static' as const,
  };
  /** A runner that answers everything successfully, so a skip cannot be read as a failure. */
  const workingRunner = (): SandboxRunner => ({
    runCommand: vi.fn(async () => ({ stdout: '{}', stderr: '', exitCode: 0, success: true })),
  });

  it('dispatches no node tooling at all, so the absent tool rows do not mean "clean"', async () => {
    const sandbox = workingRunner();

    const findings = await runStaticAnalysis('STATIC_HTML', sandbox);

    // Asserted against a runner that would have answered, so this reads "nothing was asked"
    // rather than "nothing was available". If `runStaticAnalysis` ever starts dispatching
    // here, the copy of its `skipNode` in `checksWithVerdict` is what has to move with it.
    expect(sandbox.runCommand).not.toHaveBeenCalled();
    expect(findings).toEqual([]);
  });

  it('counts zero verdicts even with a working build runner', async () => {
    const result = await runCodeScan({ ...staticHtmlInput, sandbox: workingRunner() });

    // The identical call reads 5 for NEXTJS. Drop the `STATIC_HTML` arm from
    // `checksWithVerdict` and this becomes 4 — four checks nobody dispatched, counted as
    // verdicts about the user's code.
    expect(result.checksRun).toBe(0);
    expect(result.findings.every((row) => row.category === 'tool')).toBe(true);
  });

  it('stores no CodeAudit row for such a project, which is what the count is for', async () => {
    // The consequence rather than the proxy: `checksRun` matters only because
    // `performCodeAudit` gates the row on it, so the drift has to be caught where the user
    // would see it — an audit in the database whose entire content is "not run".
    prisma.project.findFirst.mockResolvedValue({ ...PROJECT, stack: 'STATIC_HTML' });

    await runAutoCodeAudit('p1', BUILD_ID);
    await scanSettled();

    expect(prisma.codeAudit.create).not.toHaveBeenCalled();
    expect(signals.recordCodeAuditSignals).not.toHaveBeenCalled();
  });
});

/* ------------------------ A: an automatic scan that learned nothing claims nothing */

describe('the automatic post-build scan stores no verdict it did not reach', () => {
  it('writes no CodeAudit row, so the Quality panel keeps its empty state', async () => {
    await runAutoCodeAudit('p1', BUILD_ID);
    await scanSettled();

    expect(prisma.codeAudit.create).not.toHaveBeenCalled();

    const polled = await getLatestCodeAudit('p1');
    expect(polled.ok).toBe(true);
    if (!polled.ok) throw new Error('unreachable');
    expect(polled.data.audit).toBeNull();
    expect(polled.data.scanning).toBe(false);
  });

  it('records no quality signal either, so no metric is fabricated from the silence', async () => {
    await runAutoCodeAudit('p1', BUILD_ID);
    await scanSettled();

    // `recordCodeAuditSignals` is keyed to a `codeAuditId`, and a `build_success` or
    // `ts_errors` reading taken from checks that never started is the F-705 shape again.
    expect(signals.recordCodeAuditSignals).not.toHaveBeenCalled();
  });

  it('says nothing to the user, because nobody asked for this scan', async () => {
    await runAutoCodeAudit('p1', BUILD_ID);
    const filed = await scanSettled();

    // Filing it as a failure would put a red alert on the Quality panel of every project
    // after every build, for a limitation of the installation rather than anything in the
    // user's site.
    expect(filed.status).toBe('SUCCEEDED');
    expect(filed.errorCode).toBeNull();
    expect(filed.errorMessage).toBeNull();

    const polled = await getLatestCodeAudit('p1');
    expect(polled.ok).toBe(true);
    if (!polled.ok) throw new Error('unreachable');
    expect(polled.data.lastError).toBeNull();
  });

  it('still files the AUDIT row, because that row is what closes the build’s warrant', async () => {
    await runAutoCodeAudit('p1', BUILD_ID);
    const filed = await scanSettled();

    // `codeScanAttemptedSince` reads this row. Without it a replayed settled job id buys a
    // fresh snapshot read and scan for the whole warrant window — the `CodeAudit` row that
    // used to close the warrant is exactly the one this outcome no longer writes.
    expect(filed.currentStep).toBe(CODE_AUDIT_STEP);
    // An operator reading /admin/jobs has to be able to tell a scan that measured the
    // project from one that discovered it had no tooling to measure it with; otherwise a
    // succeeded row beside an empty Quality panel looks like a lost write.
    expect(filed.steps[0].label).toBe('No code check could run');
  });

  it('spends nothing on either ledger', async () => {
    await runAutoCodeAudit('p1', BUILD_ID);
    await scanSettled();

    expect(expensive.runAiReview).not.toHaveBeenCalled();
    expect(expensive.runA11yAudit).not.toHaveBeenCalled();
    expect(consumption.recordJobUsage).not.toHaveBeenCalled();
    expect(usageCosts.logGenerationEvent).not.toHaveBeenCalled();
  });
});

/* -------------------- A: the person who pressed Scan is owed the opposite treatment */

describe('a manual Scan that could check nothing says so', () => {
  it('reports it as a failure the panel can show, naming whose problem it is', async () => {
    await runCodeAudit('p1');
    const filed = await scanSettled();

    // They spent an audit credit and are watching a spinner; leaving them on the panel's
    // "nothing scanned yet" empty state reads as a press that did not register.
    expect(filed.status).toBe('FAILED');
    expect(filed.errorCode).toBe('no_checks_available');
    expect(filed.errorMessage).toContain('build runner');
    expect(filed.errorMessage).toContain('Nothing is wrong with your project');

    prisma.job.findFirst.mockResolvedValue({
      errorMessage: filed.errorMessage,
      finishedAt: new Date(),
      createdAt: new Date(),
    });
    const polled = await getLatestCodeAudit('p1');
    expect(polled.ok).toBe(true);
    if (!polled.ok) throw new Error('unreachable');
    expect(polled.data.lastError).toBe(filed.errorMessage);
    expect(polled.data.audit).toBeNull();
  });

  it('stores no row and no signal for it either, however it is reported', async () => {
    await runCodeAudit('p1');
    await scanSettled();

    expect(prisma.codeAudit.create).not.toHaveBeenCalled();
    expect(signals.recordCodeAuditSignals).not.toHaveBeenCalled();
  });
});

/* --------------------------------- B: the AI review's spend reaches /admin/usage too */

describe('a manual AI review appears in the source /admin/usage reads', () => {
  const USAGE = {
    tokensIn: 39_000,
    tokensOut: 1_200,
    calls: 1,
    estimatedCalls: 0,
    provider: null as string | null,
    model: 'deepseek-v4-flash' as string | null,
  };

  /** A review that reached the provider; `null` usage means no call ever went out. */
  function reviewSpent(usage: typeof USAGE | null = USAGE) {
    expensive.runAiReview.mockResolvedValue({
      findings: [
        finding({
          id: 'ai-review:app/page.tsx:0:Unbounded state',
          category: 'ai-review',
          status: 'medium',
          title: 'Unbounded state growth',
          detail: 'The list never drops entries.',
        }),
      ],
      usage,
    });
  }

  /** What `logGenerationEvent` was handed for this scan. */
  function loggedEvent() {
    return usageCosts.logGenerationEvent.mock.calls[0][0] as {
      projectId: string;
      userId: string;
      kind: string;
      isUrlClone: boolean;
      inputTokens: number;
      outputTokens: number;
      model: string | null;
      accrueToSpendCeiling?: boolean;
    };
  }

  it('writes the GenerationEvent as well as the job row, for the same tokens', async () => {
    reviewSpent();

    await runCodeAudit('p1');
    await scanSettled();

    // Two ledgers, both required. `recordJobUsage` moves `Workspace.spendUsd` and the
    // auto-pause that reads it; `GenerationEvent` is what every /admin/usage panel
    // aggregates — `getUsageSummary`, `getUsageByMember` and `getProjectUsageEvents` read
    // that table and nothing else. Writing only the first is how an operator watched the
    // ceiling move while the dashboard reported no AI spend for audits at all.
    expect(consumption.recordJobUsage).toHaveBeenCalledTimes(1);
    expect(usageCosts.logGenerationEvent).toHaveBeenCalledTimes(1);
    const job = consumption.recordJobUsage.mock.calls[0][0] as {
      tokensIn: number;
      tokensOut: number;
    };
    // One review, one number: the two ledgers are priced from the same token counts, so
    // /admin/jobs and /admin/usage cannot disagree about what a Scan cost.
    expect(loggedEvent()).toMatchObject({
      projectId: 'p1',
      userId: 'user-1',
      // Not `initial` or `followup`: `BUILD_KINDS` in lib/signals/collect.ts is those two,
      // so filing a scan under either would make it the project's newest build event and
      // the quality dashboard would score a Scan as though the model had written a site.
      kind: 'audit',
      // Nothing was fetched — the review reads the files the project already has.
      isUrlClone: false,
      inputTokens: job.tokensIn,
      outputTokens: job.tokensOut,
      model: 'deepseek-v4-flash',
    });
  });

  it('does not ask the event to accrue, because the job row already moved the ceiling', async () => {
    reviewSpent();

    await runCodeAudit('p1');
    await scanSettled();

    // `logGenerationEvent` accrues into `Workspace.spendUsd` only when asked to. Asking
    // here counts one review twice and pauses a workspace that never reached its limit.
    expect(loggedEvent().accrueToSpendCeiling).toBeFalsy();
  });

  it('leaves a review that reported no tokens off the usage ledger', async () => {
    reviewSpent({ ...USAGE, tokensIn: 0, tokensOut: 0 });

    await runCodeAudit('p1');
    await scanSettled();

    // `calculateEventCost` falls back to the flat $0.05 `AI_GENERATION_ESTIMATE` when a
    // call reports no tokens at all, which would put a price on /admin/usage against the
    // $0 the job row records for the same review. The zero belongs on the job row, where
    // it is the truth, and nowhere else.
    expect(consumption.recordJobUsage).toHaveBeenCalledTimes(1);
    expect(usageCosts.logGenerationEvent).not.toHaveBeenCalled();
  });

  it('writes to neither when the review never reached a provider', async () => {
    reviewSpent(null);

    await runCodeAudit('p1');
    await scanSettled();

    expect(consumption.recordJobUsage).not.toHaveBeenCalled();
    expect(usageCosts.logGenerationEvent).not.toHaveBeenCalled();
  });

  it('still writes the usage ledger when the job-row write failed', async () => {
    reviewSpent();
    consumption.recordJobUsage.mockRejectedValue(new Error('job row vanished'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runCodeAudit('p1');
    await scanSettled();

    // Guarded separately on purpose: one ledger failing must not silently take the other
    // with it, and neither may turn a finished scan into a failed one.
    expect(usageCosts.logGenerationEvent).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('still writes the job row, and still succeeds, when the usage ledger failed', async () => {
    reviewSpent();
    usageCosts.logGenerationEvent.mockRejectedValue(new Error('event table is down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runCodeAudit('p1');
    const filed = await scanSettled();

    expect(consumption.recordJobUsage).toHaveBeenCalledTimes(1);
    expect(filed.status).toBe('SUCCEEDED');
    warn.mockRestore();
  });

  it('records the spend on both even when the scan died after the model answered', async () => {
    reviewSpent();
    prisma.codeAudit.create.mockRejectedValue(new Error('storage write failed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runCodeAudit('p1');
    await scanSettled();

    // Tokens that have already left do not become unspent because the row that was going
    // to describe them failed to save.
    expect(consumption.recordJobUsage).toHaveBeenCalledWith(
      expect.objectContaining({ tokensIn: 39_000 }),
    );
    expect(loggedEvent()).toMatchObject({ inputTokens: 39_000, outputTokens: 1_200 });
    warn.mockRestore();
  });
});
