'use server';

import { prisma } from '@/lib/db';
import { getSessionUser, type SessionUser } from '@/lib/auth';
import { peekActor } from '@/lib/projects/plan';
import { captureFileSnapshot } from '@/lib/checkpoints/snapshot';
import { getStack } from '@/lib/stacks';
import { asFindings } from '@/lib/seo/findings';
import { auditPreviewUrl } from '@/lib/preview/url';
import { asCodeFindings, asMetrics, mergeIgnoredFindings } from './findings';
import { buildFixAllInstruction, buildFixInstruction } from './fix-instruction';
import { groupRecurringIssues, type RecurringIssue } from './recurring';
import { runCodeScan, type CodeScanDepth } from './scan';
// Static rather than the `await import(…)` `recordJobUsage` beside it still uses, and
// `recordScanSpend` must call *this* binding rather than re-importing the module under the
// same name: the call sits inside the detached chain's `try`, ahead of the `finally` that
// gives the in-process scan claim back, so loading `@/lib/usage-costs` and its graph on
// the first scan of a process held that claim open — long enough that the next Scan press
// was answered "a scan is already running" and the tests that press twice saw the first
// run's claim outlive its own assertions. A local `const { logGenerationEvent } = await
// import(…)` shadows this one, which puts the load back inside the window and leaves the
// import above unused; `@typescript-eslint/no-unused-vars` is what catches that.
// Nothing in `@/lib/usage-costs` imports the audit, so there is no cycle for laziness to
// break either.
import { logGenerationEvent } from '@/lib/usage-costs';
import type { GenerationEventKind } from '@/lib/usage-estimates';
import type { AiReviewUsage } from './ai-review';
import type { CodeFinding, PublicCodeAudit } from './types';
import { recordCodeAuditSignals } from '@/lib/signals/collect';
import { asCreditActionErr } from '@/lib/plans/http';
import { checkCredits, consumeCredits } from '@/lib/plans/limits';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import {
  projectHasPublishableFiles,
  PUBLISH_FILES_UNAVAILABLE,
  type PublishableFilesState,
} from '@/lib/publish/files';
import { holdProjectLock } from '@/lib/projects/lock';
import { lockConflictAction } from '@/lib/projects/lock-http';
import { CODE_AUDIT_STEP, auditRunFailureMessage } from './poll-state';

type ActionErr = { ok: false; error: string; status: number; details?: unknown };
type ActionOk<T> = { ok: true; data: T };
type ActionResult<T> = ActionOk<T> | ActionErr;

/**
 * The in-process claim on "a code scan is running for this project".
 *
 * A token rather than the scan's promise because nothing ever awaits the value — every
 * reader asks `has` — and because giving a claim back has to prove ownership. Two
 * overlapping scans that both called `inflight.delete(projectId)` on the way out meant the
 * first to finish cleared the entry the second still held, so `getLatestCodeAudit` reported
 * `scanning: false` mid-scan: the Quality panel's spinner stopped and the Scan button came
 * back while the AI review was still running.
 */
type ScanClaim = { readonly projectId: string };

const inflight = new Map<string, ScanClaim>();

/**
 * Take the claim, or report that someone else holds it — without yielding in between.
 *
 * `if (!inflight.has(id)) { await …; inflight.set(id, …) }` is not mutual exclusion. Node
 * interleaves at every await, so an owner firing N parallel POSTs of the same settled build
 * cleared that check N times and bought N concurrent AI reviews on the workspace's provider
 * key, none of them charged — the auto path exists precisely because it charges nothing.
 * Nothing between the read and the write below may await, now or later.
 *
 * What it guarantees is one scan per project *per process*. It is not a distributed lock:
 * a second app instance keeps its own map, and a restart forgets this one. The durable half
 * of the bound is the warrant plus the attempt record (`codeScanAttemptedSince`).
 */
function claimScan(projectId: string): ScanClaim | null {
  if (inflight.has(projectId)) return null;
  const claim: ScanClaim = { projectId };
  inflight.set(projectId, claim);
  return claim;
}

/** Give a claim back, and only if the map still holds ours — see `ScanClaim`. */
function releaseScan(claim: ScanClaim): void {
  if (inflight.get(claim.projectId) === claim) inflight.delete(claim.projectId);
}

function unauthorized(): ActionErr {
  return { ok: false, error: 'Sign in required', status: 401 };
}

function notFound(): ActionErr {
  return { ok: false, error: 'Project not found', status: 404 };
}

function forbidden(): ActionErr {
  return { ok: false, error: 'Forbidden', status: 403 };
}

function canMutate(user: SessionUser, ownerId: string) {
  return user.id === ownerId || user.role === 'ADMIN';
}

async function requireActor() {
  const stored = peekActor();
  if (stored) return { user: stored, err: null };
  const user = await getSessionUser();
  if (!user) return { user: null, err: unauthorized() as ActionErr };
  return { user, err: null };
}

function toPublic(row: {
  id: string;
  projectId: string;
  findings: unknown;
  metrics: unknown;
  scannedAt: Date;
}): PublicCodeAudit {
  return {
    id: row.id,
    projectId: row.projectId,
    findings: asCodeFindings(row.findings),
    metrics: asMetrics(row.metrics),
    scannedAt: row.scannedAt.toISOString(),
  };
}

async function latestRow(projectId: string) {
  return prisma.codeAudit.findFirst({
    where: { projectId },
    orderBy: { scannedAt: 'desc' },
  });
}

/**
 * See the twin in `lib/seo/actions.ts`: what the Scan button needs before the user
 * presses it, folded from `projectHasPublishableFiles`'s three-way answer into a
 * `hasFiles`/`filesHint` pair. This feeds a poll (`getLatestCodeAudit` is hit every
 * few seconds while scanning), so an unexpected failure here must not take the
 * whole poll down with it — it fails the same way `projectHasPublishableFiles`
 * reports a storage read it could not complete, not by throwing.
 */
async function auditFilesReadiness(
  projectId: string,
): Promise<{ hasFiles: boolean; filesHint: string | null }> {
  try {
    const filesState = await projectHasPublishableFiles(projectId);
    if (filesState.status === 'ready') return { hasFiles: true, filesHint: null };
    if (filesState.status === 'unavailable') {
      return { hasFiles: false, filesHint: filesState.reason };
    }
    return { hasFiles: false, filesHint: 'Generate the project first' };
  } catch (error) {
    console.warn('[audit] file readiness check failed', error);
    return { hasFiles: false, filesHint: PUBLISH_FILES_UNAVAILABLE };
  }
}

/**
 * N-005: this is a `'use server'` export, so it is reachable as an endpoint by
 * anyone who can post to the app — and it used to answer, for any project id,
 * whether a scan was running. That is an activity and existence oracle for
 * projects the caller cannot see. It is a read, but it is a read *about one
 * project*, so it owes the same session + ownership answer the mutations do.
 */
export async function isCodeScanInFlight(
  projectId: string,
): Promise<ActionResult<{ inFlight: boolean }>> {
  const { user, err } = await requireActor();
  if (!user) return err;

  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, ownerId: true },
  });
  if (!project) return notFound();
  if (!canMutate(user, project.ownerId)) return forbidden();

  return { ok: true, data: { inFlight: inflight.has(projectId) } };
}

/**
 * `'project_deleted'` rather than `false`: the caller turns the outcome into a job
 * failure, and a row that no longer exists is not an AI-provider miss. Filing it as
 * `provider_error` pointed /admin/jobs at DeepSeek for a deleted project (F-821).
 *
 * `'nothing_checked'` is the scan that finished cleanly having learned nothing — every
 * check reported that it could not run. It is not a failure of the scan and not a verdict
 * on the code, and the two entry points owe the user different answers for it, so it is
 * its own outcome rather than either of the others. See `performCodeAudit`.
 *
 * `aiUsage` is what the AI review spent, handed back for the caller to record. It is
 * always null on the `static` depth, which makes no provider call at all.
 */
type CodeAuditRun = {
  outcome: 'ran' | 'project_deleted' | 'nothing_checked';
  aiUsage: AiReviewUsage | null;
};

/**
 * Where the provider spend is written the instant it is known.
 *
 * A mutable sink rather than only a return value because everything after the provider
 * call can still throw — `prisma.codeAudit.create`, the signal write — and tokens that
 * have already left do not become unspent because the row that was going to describe
 * them failed to save. The caller's catch reads this and still accrues.
 */
type ScanSpendSink = { aiUsage: AiReviewUsage | null };

async function performCodeAudit(
  projectId: string,
  depth: CodeScanDepth,
  spend: ScanSpendSink,
): Promise<CodeAuditRun> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, stack: true, designDirection: true, ownerId: true },
  });
  if (!project) return { outcome: 'project_deleted', aiUsage: null };

  const [previous, latestSeo] = await Promise.all([
    latestRow(projectId),
    prisma.seoAudit.findFirst({
      where: { projectId },
      orderBy: { scannedAt: 'desc' },
      select: { findings: true },
    }),
  ]);
  const files = await captureFileSnapshot(projectId);
  const stack = getStack(project.stack).id;
  // Nothing executes server-side any more: the live preview is compiled and
  // run in the user's browser. Only a published static build has a URL an
  // auditor can visit, and there is no runner for build-time checks.
  let previewUrl: string | null = null;
  const sandbox = null;
  try {
    previewUrl = await auditPreviewUrl(projectId, 'code-audit');
  } catch (error) {
    console.warn('[audit] preview URL unavailable, scanning files only', error);
  }
  const scanned = await runCodeScan({
    stack,
    files,
    previewUrl,
    sandbox,
    seoFindings: asFindings(latestSeo?.findings),
    directionId: project.designDirection,
    // The audit belongs to the project owner — the same subject the PLAN job
    // resolves with — so the AI review uses one credential per project (F-073).
    userId: project.ownerId,
    depth,
  });
  // Before anything that can throw: see {@link ScanSpendSink}.
  spend.aiUsage = scanned.aiUsage;
  // A scan where nothing could run is not a quality signal; it is noise with a database
  // row attached. Round 5 correctly stopped the automatic scan from making a paid call and
  // forking a Chromium, and the four static checks then short-circuited on the null
  // `SandboxRunner` — so every automatic scan stored six findings, all category `tool`,
  // all "could not run", and metrics reading zero errors across the board. The Quality
  // panel renders that as a completed audit with a clean scorecard, which is a verdict
  // nobody reached; `groupRecurringIssues` counted it once per project per build, so the
  // operator's "top recurring issues in generated code" panel filled with the absence of a
  // build runner. Storing nothing is the honest outcome: the panel keeps its empty state,
  // which already says these checks need a runner this instance does not have.
  //
  // Deliberately not depth-conditional. A `full` scan on a deployment with no browser and
  // an unreachable provider learns exactly as little, and would store exactly the same
  // false scorecard.
  if (scanned.checksRun === 0) {
    return { outcome: 'nothing_checked', aiUsage: scanned.aiUsage };
  }
  const findings = mergeIgnoredFindings(scanned.findings, asCodeFindings(previous?.findings));

  const created = await prisma.codeAudit.create({
    data: {
      projectId,
      findings,
      metrics: scanned.metrics,
    },
  });
  void recordCodeAuditSignals({
    projectId,
    codeAuditId: created.id,
    // What the scan actually measured, not what its finding counts imply. A
    // check that could not run reports `null` here and is recorded as nothing
    // rather than as a perfect score (F-705, F-816).
    ...scanned.signals,
  });
  return { outcome: 'ran', aiUsage: scanned.aiUsage };
}

/** One label for both entry points, so /admin/jobs reads the same either way. */
const CODE_SCAN_STEP_LABEL = 'Scanning the project';

/**
 * The step label for a run that finished having checked nothing.
 *
 * The label is the outcome, not the entry point, so this does not break the rule above:
 * an operator reading /admin/jobs must be able to tell an AUDIT row that measured the
 * project from one that only discovered it had no tooling to measure it with — otherwise
 * a succeeded row beside an empty Quality panel looks like a lost write.
 */
const CODE_SCAN_NOTHING_CHECKED_LABEL = 'No code check could run';

/** F-819/F-821: a deleted project is not an AI-provider miss, and the poll has to read it. */
const CODE_SCAN_DELETED_MESSAGE = 'The project was deleted before the audit ran';

/**
 * What the user reads when they pressed Scan and no check could run.
 *
 * The automatic scan says nothing at all in this case — see `startDetachedCodeScan` — but
 * a person who pressed the button spent an audit credit and is watching a spinner, and
 * leaving them on the panel's "nothing scanned yet" empty state tells them the press did
 * not register. It names the checks so the sentence is actionable by whoever can act:
 * every one of them is the operator's to install, not the user's to write around.
 */
const CODE_SCAN_NOTHING_CHECKED_MESSAGE =
  'No code check could run on this deployment — the TypeScript, lint, dependency and dead-code checks need a build runner, and the accessibility and AI review passes could not run either. Nothing is wrong with your project; an operator has to enable these checks.';

/**
 * How long after a build settles the scan it is owed may still be claimed.
 *
 * See `findRecentlySucceededBuild`: this is the window a warrant is good for, and it is
 * generous only because the settle kicks the scan within milliseconds — anything much
 * later is a replay, not a build waiting for its first quality signal.
 */
const AUTO_SCAN_WARRANT_MS = 15 * 60_000;

/**
 * Has a code scan of this project already been *attempted* since `since`?
 *
 * The single-shot guard used to be "a `CodeAudit` row newer than the build", and
 * `performCodeAudit` writes that row only after `runCodeScan` returns. A scan that threw
 * wrote no row at all, so the warrant never closed and the same settled job id bought a
 * fresh run on every replay for the full `AUTO_SCAN_WARRANT_MS`. Recording the success is
 * not the same as recording the attempt. The automatic scan no longer calls a provider,
 * so a replay is cheap rather than billed — but it is still a storage read, a snapshot and
 * an AUDIT job row per replay, and the guard is what bounds it.
 *
 * Every run leaves an AUDIT job row carrying the `CODE_AUDIT_STEP` marker whether it
 * succeeded or failed — both entry points file one from `recordScanRun` — so that row is
 * the attempt record. `createdAt` is when the run began (`insertSettledJob` back-dates it
 * to `startedAt`), which is what has to be compared against the build's `finishedAt`.
 * Unlike the in-process claim this survives a restart and is visible to a second app
 * instance, so it is the half of the bound that actually holds when more than one process
 * can serve the same warrant.
 */
async function codeScanAttemptedSince(projectId: string, since: Date): Promise<boolean> {
  const attempt = await prisma.job.findFirst({
    where: {
      projectId,
      kind: 'AUDIT',
      currentStep: CODE_AUDIT_STEP,
      createdAt: { gte: since },
    },
    select: { id: true },
  });
  return attempt !== null;
}

/**
 * File a finished scan as an already-settled job row.
 *
 * No scan holds a live row any more — the automatic one never did, and the manual one
 * stopped because `one_active_job_per_project` makes a live AUDIT row the project's build
 * slot (see `runCodeAudit`) — so this is the only trace either leaves: /admin/jobs reads
 * it, and `getLatestCodeAudit` reads it as `lastError` through the
 * `currentStep: CODE_AUDIT_STEP` marker. A row of its own is also what keeps the two scans
 * apart: sharing one row is how a failing code scan was reported to the user as an SEO
 * failure while the code panel said nothing was wrong.
 */
async function recordScanRun(input: {
  projectId: string;
  userId: string;
  startedAt: Date;
  errorCode?: string;
  errorMessage?: string;
  /** Overrides {@link CODE_SCAN_STEP_LABEL} for an outcome the default label misdescribes. */
  stepLabel?: string;
  /** What the AI review spent, if it ran. See {@link recordScanSpend}. */
  aiUsage?: AiReviewUsage | null;
}): Promise<void> {
  const { insertSettledJob } = await import('@/lib/jobs/store');
  const finishedAt = new Date();
  const failed = Boolean(input.errorCode);
  const row = await insertSettledJob({
    projectId: input.projectId,
    workspaceId: WORKSPACE_ROW_ID,
    userId: input.userId,
    kind: 'AUDIT',
    status: failed ? 'FAILED' : 'SUCCEEDED',
    startedAt: input.startedAt,
    finishedAt,
    currentStep: CODE_AUDIT_STEP,
    steps: [
      {
        key: CODE_AUDIT_STEP,
        label: input.stepLabel ?? CODE_SCAN_STEP_LABEL,
        status: failed ? 'failed' : 'succeeded',
        startedAt: input.startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        error: input.errorMessage ?? null,
      },
    ],
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage ?? null,
  });
  await recordScanSpend({
    jobId: row?.id ?? null,
    projectId: input.projectId,
    userId: input.userId,
    usage: input.aiUsage ?? null,
  });
}

/**
 * The `GenerationEvent.kind` an AI code review is filed under.
 *
 * Not one of the four `GenerationEventKind` names, and deliberately so: those are all
 * generations of the user's site, and `BUILD_KINDS` in `lib/signals/collect.ts` is
 * `['initial', 'followup']`. Filing a scan as either would make it the project's newest
 * build event, pair it with a `revert_rate` row and count it in `followups_to_settle`, so
 * the quality dashboard would score a scan as though the model had written a site — the
 * F-820 shape, from the other end. `'plan'` and `'image'` are outside `BUILD_KINDS` but
 * would print the wrong word on /admin/usage → project, which reads `kind` verbatim.
 *
 * The column is a plain `String` (prisma/schema.prisma) so `'audit'` stores and renders
 * correctly today; the assertion below is only the TypeScript union catching up.
 * `GenerationEventKind` lives in `lib/usage-estimates.ts`, which this change may not
 * edit — adding `| 'audit'` there is what deletes the annotation and the cast together.
 */
const AUDIT_EVENT_KIND: string = 'audit';

/**
 * Put the AI review's tokens where every ledger that counts money can see them.
 *
 * The audit's `generateText` carries up to 40 000 input tokens of the user's source and
 * nothing recorded it: not `recordJobUsage`, not `accrueSpend`, not a `GenerationEvent`.
 * So the spend existed on the operator's provider invoice and nowhere in the product.
 * Whether the *user* is charged a credit is a separate question with a separate answer;
 * being free to the user has never meant being invisible to the operator.
 *
 * It takes two writes because the product keeps two ledgers, and closing only one leaves
 * the other still reporting zero:
 *
 *  - `recordJobUsage` stamps `tokensIn` / `tokensOut` / `estimatedCostUsd` on the AUDIT
 *    row (/admin/jobs) and accrues into `Workspace.spendUsd`, which is what the documented
 *    100 %-of-ceiling auto-pause (`pauseReason=SPEND_LIMIT`) reads.
 *  - `logGenerationEvent` writes the `GenerationEvent` row. Every /admin/usage panel is
 *    fed by that table and nothing else — `getUsageSummary`, `getUsageByMember` and
 *    `getProjectUsageEvents` all aggregate `prisma.generationEvent` — so with only the
 *    first write an operator running fifty manual Scans a day watched the spend ceiling
 *    move and /admin/jobs show the tokens, while the usage dashboard reported no AI spend
 *    for audits at all. A generation has always done both; the audit did the first only.
 *
 * Both price the same tokens through `estimateTokenCost` with `loadOperatorTokenRate`, so
 * the two ledgers carry the same number for one review rather than two.
 *
 * `accrueToSpendCeiling` is deliberately not passed. `recordJobUsage` already accrues
 * these tokens into `Workspace.spendUsd`, and `logGenerationEvent` documents that a caller
 * doing both must leave the flag off — setting it here would move the ceiling twice for
 * one review and pause a workspace that never reached its limit.
 *
 * The `tokensIn + tokensOut > 0` guard is what keeps that true at the boundary:
 * `calculateEventCost` falls back to the flat `AI_GENERATION_ESTIMATE` when a call
 * reports no tokens at all, which would put $0.05 on /admin/usage against $0 on the job
 * row for the same review. A call with nothing to price is recorded on the job row (where
 * the zero is the truth) and left off the usage ledger.
 *
 * Failure to record is logged and never rethrown: the scan itself is finished, and losing
 * the accounting must not turn a completed scan into a failed one — but it must not pass
 * in silence either. The two writes are guarded separately so a failure in one still
 * leaves the other's ledger correct.
 */
async function recordScanSpend(input: {
  jobId: string | null;
  projectId: string;
  userId: string;
  usage: AiReviewUsage | null;
}): Promise<void> {
  const { jobId, projectId, userId, usage } = input;
  if (!usage) return;
  if (jobId) {
    try {
      const { recordJobUsage } = await import('@/lib/consumption/record');
      await recordJobUsage({
        jobId,
        workspaceId: WORKSPACE_ROW_ID,
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        provider: usage.provider,
        model: usage.model,
      });
    } catch (error) {
      console.warn('[audit] recording the AI review spend on the job row failed', jobId, error);
    }
  }
  if (usage.tokensIn + usage.tokensOut <= 0) return;
  try {
    await logGenerationEvent({
      projectId,
      userId,
      kind: AUDIT_EVENT_KIND as GenerationEventKind,
      // No page was fetched: the review reads the files the project already has.
      isUrlClone: false,
      inputTokens: usage.tokensIn,
      outputTokens: usage.tokensOut,
      provider: usage.provider,
      model: usage.model,
    });
  } catch (error) {
    console.warn('[audit] recording the AI review spend on /admin/usage failed', projectId, error);
  }
}

/**
 * Run the scan holding no job row, and record it when it is over.
 *
 * `createOrReuseJob` resolves contention through `getActiveJob`, which is kind-blind, and
 * the database backs that with `one_active_job_per_project`: one live row per project,
 * full stop. A scan that holds that row is therefore a scan that refuses the user's next
 * message. Auto-kicking one after every build made that the normal case — a landing page
 * finished, the audit took the slot, and "make the header blue" came back with "A build is
 * already running on this project, so your message was not sent." for a build that had
 * ended two seconds earlier. The automatic build-fix loop got the same refusal and told
 * the user "The automatic build fix produced no changes" instead of repairing anything.
 *
 * So no scan takes the job row, and both entry points come through here. The automatic
 * one additionally takes no credit and no project lock — the lock is re-entrant for one
 * user, so a scan holding it would be released out from under a build the same person
 * started in the meantime (the NAV-03 shape), and for anyone else on the project it is a
 * straight block. The manual one still charges and still holds the lock, because a person
 * asked for it and is waiting on it. The cost either way is that the file snapshot is a
 * point-in-time read that a concurrent build may already have moved past; the scan is
 * advisory and the next build kicks the next one, so that is the right trade.
 *
 * `automatic` is the one place the two entry points are told apart *after* the scan, and
 * it exists for the `nothing_checked` outcome. Nobody asked for the automatic scan, so a
 * run that could check nothing is filed as a plain succeeded row and says nothing to the
 * user: reporting it as a failure would put a red alert on the Quality panel of every
 * project after every build, for a limitation of the installation rather than anything in
 * their site. A person who pressed Scan spent a credit and is watching a spinner, so the
 * same outcome is filed as a failure carrying {@link CODE_SCAN_NOTHING_CHECKED_MESSAGE},
 * which `getLatestCodeAudit` hands back as `lastError`.
 */
function startDetachedCodeScan(input: {
  projectId: string;
  userId: string;
  /** How much of the audit to run — see {@link CodeScanDepth}. */
  depth: CodeScanDepth;
  /** Kicked by a settled build rather than by a person pressing Scan. */
  automatic: boolean;
  /**
   * The caller's claim, taken before the caller's last await rather than here. Making the
   * claim at the point the scan starts is a check-then-act with the whole eligibility
   * pipeline inside it, which is how N parallel calls all reached this function.
   */
  claim: ScanClaim;
  /** The manual path's hold, handed over so the detached chain gives it back. */
  release?: () => Promise<void>;
}): void {
  const { projectId, userId, depth, automatic } = input;
  const startedAt = new Date();
  const spend: ScanSpendSink = { aiUsage: null };
  void (async () => {
    try {
      try {
        const run = await performCodeAudit(projectId, depth, spend);
        if (run.outcome === 'ran') {
          await recordScanRun({ projectId, userId, startedAt, aiUsage: run.aiUsage });
        } else if (run.outcome === 'nothing_checked') {
          await recordScanRun({
            projectId,
            userId,
            startedAt,
            stepLabel: CODE_SCAN_NOTHING_CHECKED_LABEL,
            ...(automatic
              ? {}
              : {
                  errorCode: 'no_checks_available',
                  errorMessage: CODE_SCAN_NOTHING_CHECKED_MESSAGE,
                }),
            // A review that reached the provider and then found itself the only check that
            // ran to nothing still spent those tokens.
            aiUsage: run.aiUsage,
          });
        } else {
          await recordScanRun({
            projectId,
            userId,
            startedAt,
            errorCode: 'project_deleted',
            errorMessage: CODE_SCAN_DELETED_MESSAGE,
          });
        }
      } catch (error) {
        console.warn('[audit] code audit failed', error);
        await recordScanRun({
          projectId,
          userId,
          startedAt,
          errorCode: 'provider_error',
          errorMessage: error instanceof Error ? error.message : 'Audit failed',
          // A scan that died after the model answered still spent those tokens.
          aiUsage: spend.aiUsage,
        });
      }
    } finally {
      releaseScan(input.claim);
      await input.release?.();
    }
  })().catch((error: unknown) => {
    // The row is the whole record of an unmetered scan, so losing it matters — but a
    // detached rejection with no project id attached is a failure nobody can find.
    console.warn('[audit] recording the code scan outcome failed', projectId, error);
  });
}

/**
 * The scan a finished build is owed: unmetered, holding nothing, and running only what
 * is free and fast.
 *
 * Round 1 kicked `runCodeAudit` here, which charges an audit credit through
 * `markJobRunning({ chargeCredits: true })`. Nobody asked for it: a workspace whose plan
 * allows 20 audits a month was out of them after 20 chat turns, and the user's own Scan
 * button then failed with "credits used up" for scans they never ran. Work the user did
 * not ask for does not spend the user's credits, so this path never charges — and because
 * it never charges it is not allowed to be a free-scan endpoint either, which is what the
 * warrant below is for.
 *
 * `depth: 'static'` is the rest of that argument, and it is about the operator's money
 * rather than the user's credits. The full audit ends in a `generateText` carrying up to
 * 40 000 input tokens of the user's source, plus two Chromium page loads. Run on every
 * settled build, that is one extra paid provider call per chat turn — a workspace doing
 * 200 turns a day roughly doubled the operator's invoice — and a browser launch the
 * production image cannot satisfy, which filed a tool failure against every project after
 * every build. Neither is anything a user asked for. The static half costs nothing and
 * finishes immediately, so it is what an automatic scan is allowed to be; the two
 * expensive checks stay behind the Scan button.
 *
 * On an instance with no build runner that leaves the static half with nothing to run
 * either, so this scan stores no `CodeAudit` row at all — `performCodeAudit` refuses to,
 * and the Quality panel keeps its empty state rather than showing six "could not run" rows
 * over a scorecard of zeros. The row it does still file is the AUDIT job row, which is what
 * closes the warrant. The run is kept rather than switched off because none of that is a
 * fact about this deployment forever: give the audit a runner and the same call starts
 * producing real findings again, with nothing here to change.
 */
export async function runAutoCodeAudit(
  projectId: string,
  settledJobId: string,
): Promise<ActionResult<{ scanning: boolean }>> {
  const { user, err } = await requireActor();
  if (!user) return err;

  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, ownerId: true },
  });
  if (!project) return notFound();
  if (!canMutate(user, project.ownerId)) return forbidden();

  const { findRecentlySucceededBuild } = await import('@/lib/jobs/store');
  const build = await findRecentlySucceededBuild(
    projectId,
    typeof settledJobId === 'string' ? settledJobId : '',
    new Date(Date.now() - AUTO_SCAN_WARRANT_MS),
  );
  if (!build?.finishedAt) {
    return { ok: false, error: 'No finished build is waiting to be scanned', status: 409 };
  }
  // Single-shot per build, without a marker column: a scan row newer than the build means
  // this build has already been scanned. Without it, the same job id replayed is an
  // unbounded run of snapshot reads and scan rows on one warrant.
  const previous = await latestRow(projectId);
  if (previous && previous.scannedAt.getTime() >= build.finishedAt.getTime()) {
    return { ok: true, data: { scanning: false } };
  }
  // …and the same again for a scan that ran and failed, which writes no `CodeAudit` row at
  // all. See `codeScanAttemptedSince`: the warrant closes on the attempt, not on success.
  if (await codeScanAttemptedSince(projectId, build.finishedAt)) {
    return { ok: true, data: { scanning: false } };
  }

  // The claim closes over every remaining await, and is taken in the same synchronous step
  // as the test — see `claimScan`. Reading `inflight.has` here and setting the entry inside
  // `startDetachedCodeScan`, with `projectHasPublishableFiles` in between, let N parallel
  // POSTs of one warrant all pass and all start a scan.
  const claim = claimScan(projectId);
  if (!claim) return { ok: true, data: { scanning: true } };

  // Same guard the Scan button uses, for the same reason — an empty project has nothing to
  // audit — except that here "nothing to scan" is a normal answer rather than a refusal.
  // Every exit from here gives the claim back: one stranded by a storage blip would report
  // a scan running for as long as the process lives and block the next build's.
  let filesState: PublishableFilesState;
  try {
    filesState = await projectHasPublishableFiles(projectId);
  } catch (error) {
    releaseScan(claim);
    throw error;
  }
  if (filesState.status === 'unavailable') {
    releaseScan(claim);
    return { ok: false, error: filesState.reason, status: 503 };
  }
  if (filesState.status !== 'ready') {
    releaseScan(claim);
    return { ok: true, data: { scanning: false } };
  }

  startDetachedCodeScan({
    projectId,
    userId: build.userId,
    claim,
    depth: 'static',
    automatic: true,
  });
  return { ok: true, data: { scanning: true } };
}

/**
 * Owner/ADMIN. The Scan button: the whole audit, metered, starting immediately.
 *
 * It holds no job row, and that is the fix rather than an omission. `createOrReuseJob`
 * inserts a QUEUED row and `markJobRunning` marks it RUNNING, and
 * `one_active_job_per_project` is `UNIQUE ("projectId") WHERE status IN
 * ('QUEUED','RUNNING')` — one live row per project, whatever its kind. So an AUDIT row
 * live for the length of a scan *is* the project's build slot: the user pressed Scan,
 * typed "make the header blue", and the generation route's own
 * `createOrReuseJob({ kind: 'FOLLOWUP' })` got the audit row back from the kind-blind
 * `getActiveJob` and answered "A build is already running on this project, so your
 * message was not sent." Meanwhile `GET /api/projects/[id]/job` reads `getActiveJob`
 * first and `isChatBuilding` has no kind test, so the chat input sat locked under
 * "Building — hang tight…" for the whole scan. That is the refusal the auto path was
 * rewritten to remove, still reachable from a button.
 *
 * A kind-scoped lookup would not have fixed it: the unique index is the binding
 * constraint, so a generation that skipped the audit row would collide on the insert
 * instead, and `createOrReuseJob`'s own 23505 handler re-reads `getActiveJob` and hands
 * the audit row back anyway. The only shape that frees the slot is not taking it.
 *
 * Metering and visibility are unchanged in substance: `checkCredits` before the work and
 * `consumeCredits` once per scan (the in-process claim is what makes it once), and
 * `recordScanRun` files an AUDIT row carrying the step, the failure and — new this
 * round — the AI review's tokens and cost, so /admin/jobs and the Quality panel both
 * still see the run. What changed is that the row is written when the scan ends instead
 * of being held open while it runs.
 */
export async function runCodeAudit(projectId: string): Promise<ActionResult<{ scanning: true }>> {
  const { user, err } = await requireActor();
  if (!user) return err;

  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, ownerId: true },
  });
  if (!project) return notFound();
  if (!canMutate(user, project.ownerId)) return forbidden();

  // The Scan button must not take the lock or spend an audit credit on a project with
  // nothing to audit. Same check Publish uses (`lib/publish/actions.ts#startPublish`),
  // reused rather than re-derived, and placed before both the lock and the credit check
  // for the same reason it is there: 'unavailable' (a snapshot that could not be read) is
  // not 'empty' (nothing generated yet) and must not be reported as though it were.
  const filesState = await projectHasPublishableFiles(projectId);
  if (filesState.status === 'unavailable') {
    return { ok: false, error: filesState.reason, status: 503 };
  }
  if (filesState.status !== 'ready') {
    return { ok: false, error: 'Generate the project first', status: 400 };
  }

  const hold = await holdProjectLock(projectId, user.id, 'audit');
  if (!hold.ok) return lockConflictAction(hold);

  // An audit is already running for this project, so that chain owns the hold and will
  // give it back. Ours is either the same hold re-entered — release does nothing — or a
  // fresh take of a hold whose owner died, which we must not strand on the way out.
  //
  // Test and claim are one synchronous step (see `claimScan`) because everything below —
  // the credit check, the detached start — is an await, and the entry used to be written
  // only at the far end of it. Two clicks both got past the bare `has`, both started a
  // scan, and the first one's `finally` then deleted the entry the second owned: the
  // panel's spinner stopped and the Scan button returned mid-scan.
  const claim = claimScan(projectId);
  if (!claim) {
    await hold.release();
    return { ok: true, data: { scanning: true } };
  }

  const credits = await checkCredits(WORKSPACE_ROW_ID, user.id, 'audit');
  if (!credits.ok) {
    releaseScan(claim);
    await hold.release();
    return asCreditActionErr(credits);
  }
  const actorId = user.id;
  // Until the detached chain (with its own finally) owns the cleanup, a throw in here has
  // to hand the lock back itself; `hold.release()` stops the renew timer that would
  // otherwise keep pushing `lockExpiresAt` past its TTL for the life of the process, and
  // it is idempotent, so calling it from both paths is safe.
  try {
    // `checkCredits` above only reads the balance; this is the spend. It is unconditional
    // now because there is no longer a branch to condition on: the charge used to live
    // inside `markJobRunning({ chargeCredits: true })`, reached only when the scan owned a
    // QUEUED row, so a user whose own BUILD/FOLLOWUP/PUBLISH was live got that foreign row
    // back from the kind-blind `createOrReuseJob`, fell through to the detached path, and
    // ran the whole AI review free — once per build, indefinitely. Once per scan rather
    // than once per row is what the claim taken above guarantees.
    await consumeCredits(WORKSPACE_ROW_ID, actorId, 'audit', projectId);
    startDetachedCodeScan({
      projectId,
      userId: actorId,
      claim,
      depth: 'full',
      automatic: false,
      release: hold.release,
    });
  } catch (error) {
    releaseScan(claim);
    await hold.release();
    throw error;
  }

  return { ok: true, data: { scanning: true } };
}

/** Any signed-in member. */
export async function getLatestCodeAudit(projectId: string): Promise<
  ActionResult<{
    audit: PublicCodeAudit | null;
    scanning: boolean;
    lastError: string | null;
    hasFiles: boolean;
    filesHint: string | null;
  }>
> {
  const { user, err } = await requireActor();
  if (!user) return err;

  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true },
  });
  if (!project) return notFound();

  const row = await latestRow(projectId);
  const scanning = inflight.has(projectId);
  // F-819: a detached scan that failed (or died in a restart and was reaped)
  // only left a trace on its AUDIT job row. Surface it to the panel unless a
  // newer scan row superseded it.
  let lastError: string | null = null;
  if (!scanning) {
    const failedJob = await prisma.job.findFirst({
      where: {
        projectId,
        kind: 'AUDIT',
        currentStep: CODE_AUDIT_STEP,
        status: { in: ['FAILED', 'ABANDONED'] },
      },
      orderBy: { createdAt: 'desc' },
      select: { errorMessage: true, finishedAt: true, createdAt: true },
    });
    lastError = auditRunFailureMessage(row?.scannedAt ?? null, failedJob);
  }
  // A scan already running proves the project had files when it started — skip the
  // extra read rather than repeating it on every poll tick.
  const { hasFiles, filesHint } = scanning
    ? { hasFiles: true, filesHint: null }
    : await auditFilesReadiness(projectId);
  return {
    ok: true,
    data: {
      audit: row ? toPublic(row) : null,
      scanning,
      lastError,
      hasFiles,
      filesHint,
    },
  };
}

export async function toggleIgnoreCodeFinding(
  projectId: string,
  findingId: string,
): Promise<ActionResult<PublicCodeAudit>> {
  const { user, err } = await requireActor();
  if (!user) return err;

  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, ownerId: true },
  });
  if (!project) return notFound();
  if (!canMutate(user, project.ownerId)) return forbidden();

  const row = await latestRow(projectId);
  if (!row) return notFound();
  const findings = asCodeFindings(row.findings).map((item) =>
    item.id === findingId ? { ...item, ignored: !item.ignored } : item,
  );
  const updated = await prisma.codeAudit.update({
    where: { id: row.id },
    data: { findings },
  });
  return { ok: true, data: toPublic(updated) };
}

/**
 * F-820: this used to stamp `fixed: true` and re-read `latestRow`, which may be
 * a *newer* audit than the one the caller collected findings from — so the flags
 * could land on a different row. It now records the request, on the row the
 * caller actually read, and claims nothing about the outcome: the build runs
 * client-side after this returns and may fail, be cancelled, or hit the credit
 * limit. Whether the code changed is the next scan's answer.
 */
async function markFixRequested(rowId: string, findings: CodeFinding[], ids: string[]) {
  const wanted = new Set(ids);
  const requestedAt = new Date().toISOString();
  await prisma.codeAudit.update({
    where: { id: rowId },
    data: {
      findings: findings.map((item) =>
        wanted.has(item.id) ? { ...item, fixRequestedAt: requestedAt } : item,
      ),
    },
  });
}

/** Owner/ADMIN. One follow-up generation via the existing build path. */
export async function fixCodeFinding(
  projectId: string,
  findingId: string,
): Promise<ActionResult<{ promptContext: string; findingId: string }>> {
  const { user, err } = await requireActor();
  if (!user) return err;

  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, ownerId: true },
  });
  if (!project) return notFound();
  if (!canMutate(user, project.ownerId)) return forbidden();

  const row = await latestRow(projectId);
  if (!row) return notFound();
  const findings = asCodeFindings(row.findings);
  const target = findings.find((item) => item.id === findingId);
  if (!target) return { ok: false, error: 'Finding not found', status: 404 };
  if (target.ignored) return { ok: false, error: 'Finding is ignored', status: 409 };
  if (target.status === 'pass') return { ok: false, error: 'Finding already passes', status: 409 };

  const promptContext = buildFixInstruction(target);
  // F-820: `startFollowUpGeneration` used to be called here. It starts nothing —
  // it writes a `GenerationEvent` — and the build the client goes on to start
  // logs its own (app/api/generate-ai-code-stream/route.ts). Two rows for one
  // generation inflated `followups_to_settle` and the usage-cost roll-up for a
  // build that had not happened and might never happen.
  await markFixRequested(row.id, findings, [findingId]);
  return { ok: true, data: { promptContext, findingId } };
}

/** Owner/ADMIN. ONE combined instruction for all open findings, severity order. */
export async function fixAllCodeFindings(
  projectId: string,
): Promise<ActionResult<{ promptContext: string; findingIds: string[] }>> {
  const { user, err } = await requireActor();
  if (!user) return err;

  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, ownerId: true },
  });
  if (!project) return notFound();
  if (!canMutate(user, project.ownerId)) return forbidden();

  const row = await latestRow(projectId);
  if (!row) return notFound();
  const findings = asCodeFindings(row.findings);
  const open = findings.filter(
    (item) => !item.ignored && item.status !== 'pass' && item.fixable !== false,
  );
  if (open.length === 0) return { ok: false, error: 'No open findings to fix', status: 409 };

  const promptContext = buildFixAllInstruction(open);
  const findingIds = open.map((item) => item.id);
  await markFixRequested(row.id, findings, findingIds);
  return { ok: true, data: { promptContext, findingIds } };
}

/** ADMIN. Frequent finding categories across recent CodeAudits — input for base-rules. */
export async function getTopRecurringIssues(limit = 8): Promise<ActionResult<RecurringIssue[]>> {
  const { user, err } = await requireActor();
  if (!user) return err;
  if (user.role !== 'ADMIN') return forbidden();

  const rows = await prisma.codeAudit.findMany({
    orderBy: { scannedAt: 'desc' },
    take: 200,
    select: { findings: true },
  });
  return { ok: true, data: groupRecurringIssues(rows, limit) };
}
