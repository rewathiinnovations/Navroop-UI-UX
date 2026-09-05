'use server';

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth';
import { peekActor } from '@/lib/projects/plan';
import { captureFileSnapshot } from '@/lib/checkpoints/snapshot';
import { getStack } from '@/lib/stacks';
import { asFindings, mergeIgnoredFindings } from './findings';
import { buildFixAllInstruction, buildFixInstruction } from './fix-instruction';
import { fetchPreviewDocument, fetchPreviewText } from './live';
import { auditPreviewUrl } from '@/lib/preview/url';
import { lighthouseNeedsScanFinding, runLighthouseSeo } from './lighthouse';
import { runSeoChecks } from './scan';
import type { PublicSeoAudit, SeoFinding } from './types';
import { recordSeoScore } from '@/lib/signals/collect';
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
import { SEO_AUDIT_STEP, auditRunFailureMessage } from '@/lib/audit/poll-state';
import { canMutateOwned as canMutate } from '@/lib/auth/ownership';

type ActionErr = { ok: false; error: string; status: number; details?: unknown };
type ActionOk<T> = { ok: true; data: T };
type ActionResult<T> = ActionOk<T> | ActionErr;

/**
 * The in-process claim on "an SEO scan is running for this project".
 *
 * See the twin in `lib/audit/actions.ts`: a token rather than the scan's promise, because
 * nothing awaits the value and because release has to prove ownership. Two overlapping
 * scans that both called `inflight.delete(projectId)` meant the first to finish cleared the
 * entry the second still held, so `getLatestSeoAudit` reported `scanning: false` mid-scan
 * and the Scan button came back while the scan was still running.
 */
type ScanClaim = { readonly projectId: string };

const inflight = new Map<string, ScanClaim>();

/**
 * Take the claim, or report that someone else holds it — without yielding in between.
 *
 * See the twin in `lib/audit/actions.ts` for the whole argument. Node interleaves at every
 * await, so a `has` here and a `set` several awaits later is not mutual exclusion: N
 * parallel POSTs of one settled build all passed and all started a scan. Nothing between
 * the read and the write below may await, now or later.
 *
 * It guarantees one scan per project *per process*. It is not a distributed lock — another
 * instance keeps its own map and a restart forgets this one — so the durable half of the
 * bound is the warrant plus the attempt record (`seoScanAttemptedSince`).
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
  scannedAt: Date;
}): PublicSeoAudit {
  return {
    id: row.id,
    projectId: row.projectId,
    findings: asFindings(row.findings),
    scannedAt: row.scannedAt.toISOString(),
  };
}

async function latestRow(projectId: string) {
  return prisma.seoAudit.findFirst({
    where: { projectId },
    orderBy: { scannedAt: 'desc' },
  });
}

/**
 * What the Scan button needs before the user presses it — the same three-way
 * answer `projectHasPublishableFiles` gives `runSeoAudit`, folded into a
 * `hasFiles`/`filesHint` pair. This feeds a poll (`getLatestSeoAudit` is hit
 * every few seconds while scanning), so an unexpected failure here must not
 * take the whole poll down with it — it fails the same way
 * `projectHasPublishableFiles` reports a storage read it could not complete,
 * not by throwing.
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
    console.warn('[seo] file readiness check failed', error);
    return { hasFiles: false, filesHint: PUBLISH_FILES_UNAVAILABLE };
  }
}

/**
 * N-005: see the twin in `lib/audit/actions.ts`. A `'use server'` export that
 * answered "is a scan running for this project id?" for any caller is an
 * activity and existence oracle, so it takes the same session + ownership gate
 * as the mutations in this file.
 */
export async function isSeoScanInFlight(
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
 * How much of the audit to run. The twin of `CodeScanDepth` in `lib/audit/scan.ts`,
 * declared here rather than imported so neither subsystem's vocabulary is defined by the
 * other's — see the note there for the whole argument.
 *
 * `static` is the file checks plus the live document fetches: `runSeoChecks` is pure, and
 * the three fetches are plain HTTP against the operator's own preview origin with an 8 s
 * timeout apiece. Nothing paid, nothing forked. `full` adds `runLighthouseSeo`, which
 * launches a Chromium through `withHeadlessBrowser` — the reason an automatic scan cannot
 * have it.
 */
type SeoScanDepth = 'static' | 'full';

/**
 * `'project_deleted'` rather than `false`, matching the code twin: the caller turns the
 * outcome into a job failure, and a row that no longer exists is not an AI-provider
 * miss. Filing it as `provider_error` pointed /admin/jobs at DeepSeek (F-821).
 */
async function performSeoAudit(
  projectId: string,
  depth: SeoScanDepth,
): Promise<'ran' | 'project_deleted'> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, stack: true },
  });
  if (!project) return 'project_deleted';

  const previous = await latestRow(projectId);
  const files = await captureFileSnapshot(projectId);
  // Only a served build can be fetched. The live preview now renders in the
  // user's browser from a srcdoc, so there is no server-visitable URL unless a
  // static build was published — the file checks below still run either way.
  let previewUrl: string | null = null;
  try {
    previewUrl = await auditPreviewUrl(projectId, 'seo-audit');
  } catch (error) {
    console.warn('[seo] preview URL unavailable, auditing files only', error);
  }
  const live = previewUrl ? await fetchPreviewDocument(previewUrl) : null;
  const [liveRobots, liveSitemap] = previewUrl
    ? await Promise.all([
        fetchPreviewText(previewUrl, '/robots.txt'),
        fetchPreviewText(previewUrl, '/sitemap.xml'),
      ])
    : [null, null];

  const stack = getStack(project.stack).id;
  let findings: SeoFinding[] = runSeoChecks({
    stack,
    files,
    previewUrl,
    live,
    liveRobots,
    liveSitemap,
  });

  // A skipped check is announced, never omitted: the panel renders whatever the row
  // carries, so leaving Lighthouse out on the automatic pass would show half an audit as
  // a whole one. `lighthouseNeedsScanFinding` is `info`, which the SEO panel groups under
  // "Not checked" and the score ignores — a check nobody ran must never read as a clean
  // one. Nothing is said at all when there is no preview URL to score: Lighthouse could
  // not have run at either depth, and the file checks already carry that.
  if (previewUrl) {
    findings =
      depth === 'full'
        ? [...findings, ...(await runLighthouseSeo(previewUrl))]
        : [...findings, lighthouseNeedsScanFinding()];
  }

  findings = mergeIgnoredFindings(findings, asFindings(previous?.findings));

  const created = await prisma.seoAudit.create({
    data: {
      projectId,
      findings,
    },
  });
  void recordSeoScore(projectId, findings, created.id);
  return 'ran';
}

/** One label for both entry points, so /admin/jobs reads the same either way. */
const SEO_SCAN_STEP_LABEL = 'Scanning the project';

/** F-819/F-821: a deleted project is not an AI-provider miss, and the poll has to read it. */
const SEO_SCAN_DELETED_MESSAGE = 'The project was deleted before the audit ran';

/** See the twin in `lib/audit/actions.ts`: how long a settled build's warrant is good for. */
const AUTO_SCAN_WARRANT_MS = 15 * 60_000;

/**
 * Has an SEO scan of this project already been *attempted* since `since`?
 *
 * See the twin in `lib/audit/actions.ts`. The single-shot guard used to read `SeoAudit`,
 * which `performSeoAudit` writes only after every check has run — so a scan that threw
 * (`fetchPreviewDocument`, the storage read; Lighthouse no longer runs on this path) wrote
 * no row, the warrant never closed, and the same settled job id could be replayed for the
 * full `AUTO_SCAN_WARRANT_MS`. Every run leaves an AUDIT job row carrying the
 * `SEO_AUDIT_STEP` marker whether it succeeded or failed, and unlike the in-process claim
 * that row survives a restart and is visible to a second app instance.
 */
async function seoScanAttemptedSince(projectId: string, since: Date): Promise<boolean> {
  const attempt = await prisma.job.findFirst({
    where: {
      projectId,
      kind: 'AUDIT',
      currentStep: SEO_AUDIT_STEP,
      createdAt: { gte: since },
    },
    select: { id: true },
  });
  return attempt !== null;
}

/**
 * File a finished detached scan as an already-settled job row.
 *
 * See the twin in `lib/audit/actions.ts`. The `currentStep: SEO_AUDIT_STEP` marker is what
 * makes this row the SEO panel's and only the SEO panel's — when the two scans shared one
 * AUDIT row, whichever ran second overwrote the marker and the first one's failure was
 * either invisible or attributed to the other scan.
 */
async function recordScanRun(input: {
  projectId: string;
  userId: string;
  startedAt: Date;
  errorCode?: string;
  errorMessage?: string;
}): Promise<void> {
  const { insertSettledJob } = await import('@/lib/jobs/store');
  const finishedAt = new Date();
  const failed = Boolean(input.errorCode);
  await insertSettledJob({
    projectId: input.projectId,
    workspaceId: WORKSPACE_ROW_ID,
    userId: input.userId,
    kind: 'AUDIT',
    status: failed ? 'FAILED' : 'SUCCEEDED',
    startedAt: input.startedAt,
    finishedAt,
    currentStep: SEO_AUDIT_STEP,
    steps: [
      {
        key: SEO_AUDIT_STEP,
        label: SEO_SCAN_STEP_LABEL,
        status: failed ? 'failed' : 'succeeded',
        startedAt: input.startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        error: input.errorMessage ?? null,
      },
    ],
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage ?? null,
  });
}

/**
 * Run the scan holding no job row, and record it when it is over.
 *
 * See the twin in `lib/audit/actions.ts` for the whole argument: `one_active_job_per_project`
 * allows one live row per project, so a scan that holds it is a scan that answers "A build
 * is already running on this project" to the user's next message. Neither entry point holds
 * one now. The automatic scan additionally takes no credit and no project lock — the lock is
 * re-entrant for one user, so holding it there would release a build the same person started
 * in the meantime; the manual scan keeps both, because a person asked for it.
 */
function startDetachedSeoScan(input: {
  projectId: string;
  userId: string;
  /** How much of the audit to run — see {@link SeoScanDepth}. */
  depth: SeoScanDepth;
  /**
   * The caller's claim, taken before the caller's last await rather than here. Claiming at
   * the point the scan starts is a check-then-act with the whole eligibility pipeline
   * inside it, which is how N parallel calls all reached this function.
   */
  claim: ScanClaim;
  /** The manual path's hold, handed over so the detached chain gives it back. */
  release?: () => Promise<void>;
}): void {
  const { projectId, userId, depth } = input;
  const startedAt = new Date();
  void (async () => {
    try {
      try {
        const outcome = await performSeoAudit(projectId, depth);
        if (outcome === 'ran') {
          await recordScanRun({ projectId, userId, startedAt });
        } else {
          await recordScanRun({
            projectId,
            userId,
            startedAt,
            errorCode: 'project_deleted',
            errorMessage: SEO_SCAN_DELETED_MESSAGE,
          });
        }
      } catch (error) {
        console.warn('[seo] audit failed', error);
        await recordScanRun({
          projectId,
          userId,
          startedAt,
          errorCode: 'provider_error',
          errorMessage: error instanceof Error ? error.message : 'Audit failed',
        });
      }
    } finally {
      releaseScan(input.claim);
      await input.release?.();
    }
  })().catch((error: unknown) => {
    console.warn('[seo] recording the seo scan outcome failed', projectId, error);
  });
}

/**
 * The scan a finished build is owed: unmetered, holding nothing, and running only what is
 * free and fast.
 *
 * See the twin in `lib/audit/actions.ts`. Round 1 kicked `runSeoAudit`, which spends an
 * audit credit on work nobody asked for; this path spends none, and the warrant is what
 * stops an unmetered `'use server'` export from being a free-scan button. `depth: 'static'`
 * is the other half: Lighthouse forks a Chromium, and the production image has no browser
 * to fork, so an automatic run filed `lighthouse:unavailable` against every project after
 * every build — a permanent pseudo-defect for work nobody asked for.
 */
export async function runAutoSeoAudit(
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
  // Single-shot per build: an SEO row newer than the build means it has already been
  // scanned, so a replayed job id cannot buy a second run.
  const previous = await latestRow(projectId);
  if (previous && previous.scannedAt.getTime() >= build.finishedAt.getTime()) {
    return { ok: true, data: { scanning: false } };
  }
  // …and the same again for a scan that ran and failed, which writes no `SeoAudit` row at
  // all. See `seoScanAttemptedSince`: the warrant closes on the attempt, not on success.
  if (await seoScanAttemptedSince(projectId, build.finishedAt)) {
    return { ok: true, data: { scanning: false } };
  }

  // The claim closes over every remaining await and is taken in the same synchronous step
  // as the test — see `claimScan`. Reading `inflight.has` here and setting the entry inside
  // `startDetachedSeoScan`, with `projectHasPublishableFiles` in between, let N parallel
  // POSTs of one warrant all pass and all start a scan.
  const claim = claimScan(projectId);
  if (!claim) return { ok: true, data: { scanning: true } };

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

  startDetachedSeoScan({ projectId, userId: build.userId, claim, depth: 'static' });
  return { ok: true, data: { scanning: true } };
}

/**
 * Owner/ADMIN. The Scan button: the whole audit, metered, starting immediately.
 *
 * It holds no job row — see the twin in `lib/audit/actions.ts` for why that is the fix and
 * not an omission. In short: `one_active_job_per_project` is `UNIQUE ("projectId") WHERE
 * status IN ('QUEUED','RUNNING')`, so a live AUDIT row *is* the project's build slot, and
 * the user's next chat message came back "A build is already running on this project" with
 * the input locked under "Building — hang tight…" for the length of a scan they had
 * started themselves. Metering is unchanged (`checkCredits` then `consumeCredits`, once per
 * scan via the claim) and so is the /admin/jobs record — `recordScanRun` files the AUDIT
 * row when the scan ends instead of the scan holding one open while it runs.
 */
export async function runSeoAudit(projectId: string): Promise<ActionResult<{ scanning: true }>> {
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

  // See lib/audit/actions.ts: an audit already running for this project owns the hold and
  // gives it back itself, so ours is either that hold re-entered — release does nothing —
  // or a fresh take of a dead hold, which we must not strand on the way out. Test and claim
  // are one synchronous step (`claimScan`) because everything below is an await and the
  // entry used to be written only at the far end of it: two clicks both got past the bare
  // `has`, and the first one's `finally` then deleted the entry the second owned.
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
  // See lib/audit/actions.ts: a throw before the detached chain owns cleanup would leave
  // the lock held with its renew timer still pushing the expiry out, so the TTL never
  // rescues the project. `hold.release()` stops that timer and is idempotent.
  try {
    // See the twin: `checkCredits` only reads the balance and this is the spend. It used to
    // sit inside `markJobRunning({ chargeCredits: true })`, reachable only on a QUEUED row
    // this scan owned, so a user with their own live job fell to the detached path and got
    // the whole scan free, once per build, indefinitely. Once per scan is the claim's job.
    await consumeCredits(WORKSPACE_ROW_ID, actorId, 'audit', projectId);
    startDetachedSeoScan({
      projectId,
      userId: actorId,
      claim,
      depth: 'full',
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
export async function getLatestSeoAudit(projectId: string): Promise<
  ActionResult<{
    audit: PublicSeoAudit | null;
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
        currentStep: SEO_AUDIT_STEP,
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

export async function toggleIgnoreFinding(
  projectId: string,
  findingId: string,
): Promise<ActionResult<PublicSeoAudit>> {
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
  const findings = asFindings(row.findings).map((item) =>
    item.id === findingId ? { ...item, ignored: !item.ignored } : item,
  );
  const updated = await prisma.seoAudit.update({
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
 * limit. Whether the page changed is the next scan's answer.
 */
async function markFixRequested(rowId: string, findings: SeoFinding[], ids: string[]) {
  const wanted = new Set(ids);
  const requestedAt = new Date().toISOString();
  await prisma.seoAudit.update({
    where: { id: rowId },
    data: {
      findings: findings.map((item) =>
        wanted.has(item.id) ? { ...item, fixRequestedAt: requestedAt } : item,
      ),
    },
  });
}

/** Owner/ADMIN. One follow-up generation via the existing build path. */
export async function fixSeoFinding(
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
  const findings = asFindings(row.findings);
  const target = findings.find((item) => item.id === findingId);
  if (!target) return { ok: false, error: 'Finding not found', status: 404 };
  if (target.ignored) return { ok: false, error: 'Finding is ignored', status: 409 };
  if (target.status === 'pass') return { ok: false, error: 'Finding already passes', status: 409 };
  // An `info` finding says a check could not run — there is nothing for the
  // model to fix, and asking it to would send a follow-up generation after a
  // defect that was never observed.
  if (!target.fixable) return { ok: false, error: 'Finding cannot be fixed', status: 409 };

  const promptContext = buildFixInstruction(target);
  // F-820: `startFollowUpGeneration` used to be called here. It starts nothing —
  // it writes a `GenerationEvent` — and the build the client goes on to start
  // logs its own (app/api/generate-ai-code-stream/route.ts). Two rows for one
  // generation inflated `followups_to_settle` and the usage-cost roll-up for a
  // build that had not happened and might never happen.
  await markFixRequested(row.id, findings, [findingId]);
  return { ok: true, data: { promptContext, findingId } };
}

/** Owner/ADMIN. ONE combined instruction for all open findings. */
export async function fixAllSeoFindings(
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
  const findings = asFindings(row.findings);
  const open = findings.filter(
    (item) => !item.ignored && item.status !== 'pass' && item.fixable !== false,
  );
  if (open.length === 0) return { ok: false, error: 'No open findings to fix', status: 409 };

  const promptContext = buildFixAllInstruction(open);
  const findingIds = open.map((item) => item.id);
  await markFixRequested(row.id, findings, findingIds);
  return { ok: true, data: { promptContext, findingIds } };
}
