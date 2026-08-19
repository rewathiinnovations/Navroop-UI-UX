'use server';

import { prisma } from '@/lib/db';
import { getSessionUser, type SessionUser } from '@/lib/auth';
import { peekActor, startFollowUpGeneration } from '@/lib/projects/plan';
import { captureFileSnapshot } from '@/lib/checkpoints/snapshot';
import { getStack } from '@/lib/stacks';
import { asFindings } from '@/lib/seo/findings';
import { asCodeFindings, asMetrics, mergeIgnoredFindings } from './findings';
import { buildFixAllInstruction, buildFixInstruction } from './fix-instruction';
import { groupRecurringIssues, type RecurringIssue } from './recurring';
import { runCodeScan } from './scan';
import type { PublicCodeAudit } from './types';
import { recordCodeAuditSignals } from '@/lib/signals/collect';
import { asCreditActionErr } from '@/lib/plans/http';
import { checkCredits } from '@/lib/plans/limits';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { holdProjectLock } from '@/lib/projects/lock';
import { lockConflictAction } from '@/lib/projects/lock-http';

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

export async function isCodeScanInFlight(projectId: string) {
  return await Promise.resolve(inflight.has(projectId));
}

async function performCodeAudit(projectId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, stack: true, previewUrl: true, designDirection: true },
  });
  if (!project) return false;

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
  let previewUrl = project.previewUrl?.trim() || null;
  const sandbox = null;
  try {
    const { getProjectPreviewFields } = await import('@/lib/preview/db');
    const { signedPreviewUrl } = await import('@/lib/preview/url');
    const preview = await getProjectPreviewFields(projectId);
    previewUrl = preview?.activePreviewBuildId
      ? await signedPreviewUrl({ projectId, userId: 'code-audit' })
      : null;
  } catch (error) {
    console.warn('[audit] preview URL unavailable, scanning files only', error);
    previewUrl = null;
  }
  const scanned = await runCodeScan({
    stack,
    files,
    previewUrl,
    sandbox,
    seoFindings: asFindings(latestSeo?.findings),
    directionId: project.designDirection,
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
    metrics: scanned.metrics,
    buildOk: !findings.some((item) => item.id === 'bundle:build-failed'),
  });
  return true;
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
    await updateJobFields(auditJob.id, {
      currentStep: 'audit',
      steps: [
        {
          key: 'audit',
          label: 'Scanning the project',
          status: 'running',
          startedAt: new Date().toISOString(),
        },
      ],
    });
    const jobBeat = beginJobHeartbeat(auditJob.id);
    const job = performCodeAudit(projectId)
      .then(async (didRun) => {
        if (didRun) await succeedJob(auditJob.id);
        else
          await failJob(auditJob.id, {
            errorCode: 'provider_error',
            errorMessage: 'Audit did not run',
          });
      })
      .catch(async (error) => {
        console.warn('[audit] code audit failed', error);
        await failJob(auditJob.id, {
          errorCode: 'provider_error',
          errorMessage: error instanceof Error ? error.message : 'Audit failed',
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
  return {
    ok: true,
    data: {
      audit: row ? toPublic(row) : null,
      scanning: inflight.has(projectId),
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

async function markFixed(projectId: string, ids: string[]) {
  const row = await latestRow(projectId);
  if (!row) return;
  const wanted = new Set(ids);
  const findings = asCodeFindings(row.findings).map((item) =>
    wanted.has(item.id) ? { ...item, fixed: true } : item,
  );
  await prisma.codeAudit.update({
    where: { id: row.id },
    data: { findings },
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
  const target = asCodeFindings(row.findings).find((item) => item.id === findingId);
  if (!target) return { ok: false, error: 'Finding not found', status: 404 };
  if (target.ignored) return { ok: false, error: 'Finding is ignored', status: 409 };
  if (target.status === 'pass') return { ok: false, error: 'Finding already passes', status: 409 };

  const promptContext = buildFixInstruction(target);
  await startFollowUpGeneration({ projectId, userId: user.id, promptContext });
  await markFixed(projectId, [findingId]);
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
  const open = asCodeFindings(row.findings).filter(
    (item) => !item.ignored && item.status !== 'pass' && item.fixable !== false,
  );
  if (open.length === 0) return { ok: false, error: 'No open findings to fix', status: 409 };

  const promptContext = buildFixAllInstruction(open);
  await startFollowUpGeneration({ projectId, userId: user.id, promptContext });
  await markFixed(
    projectId,
    open.map((item) => item.id),
  );
  return { ok: true, data: { promptContext, findingIds: open.map((item) => item.id) } };
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
