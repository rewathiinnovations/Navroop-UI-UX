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
import { runCodeScan } from './scan';
import type { CodeFinding, PublicCodeAudit } from './types';
import { recordCodeAuditSignals } from '@/lib/signals/collect';
import { asCreditActionErr } from '@/lib/plans/http';
import { checkCredits } from '@/lib/plans/limits';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { holdProjectLock } from '@/lib/projects/lock';
import { lockConflictAction } from '@/lib/projects/lock-http';
import { recordJobStepFailure } from '@/lib/jobs/step-failure';
import { CODE_AUDIT_STEP, auditRunFailureMessage } from './poll-state';

type ActionErr = { ok: false; error: string; status: number; details?: unknown };
type ActionOk<T> = { ok: true; data: T };
type ActionResult<T> = ActionOk<T> | ActionErr;

const inflight = new Map<string, Promise<void>>();

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
 */
async function performCodeAudit(projectId: string): Promise<'ran' | 'project_deleted'> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, stack: true, designDirection: true, ownerId: true },
  });
  if (!project) return 'project_deleted';

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
  });
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
  return 'ran';
}

/** Owner/ADMIN. Starts the scan and returns immediately (SEO audit-style). */
export async function runCodeAudit(projectId: string): Promise<ActionResult<{ scanning: true }>> {
  const { user, err } = await requireActor();
  if (!user) return err;

  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, ownerId: true },
  });
  if (!project) return notFound();
  if (!canMutate(user, project.ownerId)) return forbidden();

  const hold = await holdProjectLock(projectId, user.id, 'audit');
  if (!hold.ok) return lockConflictAction(hold);

  // An audit is already running for this project, so that chain owns the hold and will
  // give it back. Ours is either the same hold re-entered — release does nothing — or a
  // fresh take of a hold whose owner died, which we must not strand on the way out.
  if (inflight.has(projectId)) {
    await hold.release();
    return { ok: true, data: { scanning: true } };
  }

  const credits = await checkCredits(WORKSPACE_ROW_ID, user.id, 'audit');
  if (!credits.ok) {
    await hold.release();
    return asCreditActionErr(credits);
  }
  const actorId = user.id;
  // Until the promise chain below (with its own finally) owns the cleanup, a throw in here
  // has to hand the lock back itself. The heartbeat is the dangerous half: it pushes
  // lockExpiresAt out every 60s, so the 15-minute TTL would never fire and the project
  // would stay locked for the life of the process. `hold.release()` stops that timer and
  // is idempotent, so calling it from both paths is safe.
  try {
    const { beginJobHeartbeat, createOrReuseJob, failJob, markJobRunning, succeedJob } =
      await import('@/lib/jobs/lifecycle');
    const auditJob = await createOrReuseJob({
      projectId,
      workspaceId: WORKSPACE_ROW_ID,
      userId: actorId,
      kind: 'AUDIT',
    });
    if (auditJob.status === 'QUEUED') {
      await markJobRunning(auditJob.id, { chargeCredits: true, acquireProjectLock: false });
    }
    const { updateJobFields } = await import('@/lib/jobs/store');
    const stepLabel = 'Scanning the project';
    await updateJobFields(auditJob.id, {
      currentStep: CODE_AUDIT_STEP,
      steps: [
        {
          key: CODE_AUDIT_STEP,
          label: stepLabel,
          status: 'running',
          startedAt: new Date().toISOString(),
        },
      ],
    });
    const jobBeat = beginJobHeartbeat(auditJob.id);
    const job = performCodeAudit(projectId)
      .then(async (outcome) => {
        if (outcome === 'ran') {
          await succeedJob(auditJob.id);
          return;
        }
        // F-819: the failure must survive somewhere the poll can read it —
        // the job row (failJob writes errorMessage) and its step list.
        const deletedMessage = 'The project was deleted before the audit ran';
        await recordJobStepFailure(auditJob.id, {
          key: CODE_AUDIT_STEP,
          label: stepLabel,
          error: deletedMessage,
        });
        await failJob(auditJob.id, {
          errorCode: 'project_deleted',
          errorMessage: deletedMessage,
        });
      })
      .catch(async (error) => {
        console.warn('[audit] code audit failed', error);
        const errorMessage = error instanceof Error ? error.message : 'Audit failed';
        await recordJobStepFailure(auditJob.id, {
          key: CODE_AUDIT_STEP,
          label: stepLabel,
          error: errorMessage,
        });
        await failJob(auditJob.id, {
          errorCode: 'provider_error',
          errorMessage,
        }).catch((failError) => {
          console.warn('[audit] failJob after audit failure failed', failError);
        });
      })
      .finally(async () => {
        jobBeat.stop();
        inflight.delete(projectId);
        await hold.release();
      });
    inflight.set(projectId, job);
  } catch (error) {
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
  return {
    ok: true,
    data: {
      audit: row ? toPublic(row) : null,
      scanning,
      lastError,
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
