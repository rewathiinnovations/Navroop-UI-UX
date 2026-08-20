'use server';

import { prisma } from '@/lib/db';
import { getSessionUser, type SessionUser } from '@/lib/auth';
import { peekActor, startFollowUpGeneration } from '@/lib/projects/plan';
import { captureFileSnapshot } from '@/lib/checkpoints/snapshot';
import { getStack } from '@/lib/stacks';
import { asFindings, mergeIgnoredFindings } from './findings';
import { buildFixAllInstruction, buildFixInstruction } from './fix-instruction';
import { fetchPreviewDocument, fetchPreviewText } from './live';
import { runLighthouseSeo } from './lighthouse';
import { runSeoChecks } from './scan';
import type { PublicSeoAudit, SeoFinding } from './types';
import { recordSeoScore } from '@/lib/signals/collect';
import { asCreditActionErr } from '@/lib/plans/http';
import { checkCredits } from '@/lib/plans/limits';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { holdProjectLock } from '@/lib/projects/lock';
import { lockConflictAction } from '@/lib/projects/lock-http';
import { recordJobStepFailure } from '@/lib/jobs/step-failure';
import { SEO_AUDIT_STEP, auditRunFailureMessage } from '@/lib/audit/poll-state';

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

export async function isSeoScanInFlight(projectId: string) {
  return Promise.resolve(inflight.has(projectId));
}

async function performSeoAudit(projectId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, stack: true, previewUrl: true },
  });
  if (!project) return false;

  const previous = await latestRow(projectId);
  const files = await captureFileSnapshot(projectId);
  // Only a served build can be fetched. The live preview now renders in the
  // user's browser from a srcdoc, so there is no server-visitable URL unless a
  // static build was published — the file checks below still run either way.
  let previewUrl = project.previewUrl?.trim() || null;
  try {
    const { getProjectPreviewFields } = await import('@/lib/preview/db');
    const { signedPreviewUrl } = await import('@/lib/preview/url');
    const preview = await getProjectPreviewFields(projectId);
    previewUrl = preview?.activePreviewBuildId
      ? await signedPreviewUrl({ projectId, userId: 'seo-audit' })
      : null;
  } catch (error) {
    console.warn('[seo] preview URL unavailable, auditing files only', error);
    previewUrl = null;
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

  if (previewUrl) {
    const lighthouse = await runLighthouseSeo(previewUrl);
    findings = [...findings, ...lighthouse];
  }

  findings = mergeIgnoredFindings(findings, asFindings(previous?.findings));

  const created = await prisma.seoAudit.create({
    data: {
      projectId,
      findings,
    },
  });
  void recordSeoScore(projectId, findings, created.id);
  return true;
}

/** Owner/ADMIN. Starts the scan and returns immediately (approvePlan-style). */
export async function runSeoAudit(projectId: string): Promise<ActionResult<{ scanning: true }>> {
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

  // See lib/audit/actions.ts: an audit already running for this project owns the hold and
  // gives it back itself, so ours is either that hold re-entered — release does nothing —
  // or a fresh take of a dead hold, which we must not strand on the way out.
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
  // See lib/audit/actions.ts: a throw before the promise chain owns cleanup would leave
  // the lock held with its renew timer still pushing the expiry out, so the TTL never
  // rescues the project. `hold.release()` stops that timer and is idempotent.
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
      currentStep: SEO_AUDIT_STEP,
      steps: [
        {
          key: SEO_AUDIT_STEP,
          label: stepLabel,
          status: 'running',
          startedAt: new Date().toISOString(),
        },
      ],
    });
    const jobBeat = beginJobHeartbeat(auditJob.id);
    const job = performSeoAudit(projectId)
      .then(async (didRun) => {
        if (didRun) {
          await succeedJob(auditJob.id);
          return;
        }
        // F-819: the failure must survive somewhere the poll can read it —
        // the job row (failJob writes errorMessage) and its step list.
        await recordJobStepFailure(auditJob.id, {
          key: SEO_AUDIT_STEP,
          label: stepLabel,
          error: 'Audit did not run',
        });
        await failJob(auditJob.id, {
          errorCode: 'provider_error',
          errorMessage: 'Audit did not run',
        });
      })
      .catch(async (error) => {
        console.warn('[seo] audit failed', error);
        const errorMessage = error instanceof Error ? error.message : 'Audit failed';
        await recordJobStepFailure(auditJob.id, {
          key: SEO_AUDIT_STEP,
          label: stepLabel,
          error: errorMessage,
        });
        await failJob(auditJob.id, {
          errorCode: 'provider_error',
          errorMessage,
        }).catch((failError) => {
          console.warn('[seo] failJob after audit failure failed', failError);
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
export async function getLatestSeoAudit(projectId: string): Promise<
  ActionResult<{
    audit: PublicSeoAudit | null;
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
        currentStep: SEO_AUDIT_STEP,
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

async function markFixed(projectId: string, ids: string[]) {
  const row = await latestRow(projectId);
  if (!row) return;
  const wanted = new Set(ids);
  const findings = asFindings(row.findings).map((item) =>
    wanted.has(item.id) ? { ...item, fixed: true } : item,
  );
  await prisma.seoAudit.update({
    where: { id: row.id },
    data: { findings },
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
  const target = asFindings(row.findings).find((item) => item.id === findingId);
  if (!target) return { ok: false, error: 'Finding not found', status: 404 };
  if (target.ignored) return { ok: false, error: 'Finding is ignored', status: 409 };
  if (target.status === 'pass') return { ok: false, error: 'Finding already passes', status: 409 };

  const promptContext = buildFixInstruction(target);
  await startFollowUpGeneration({ projectId, userId: user.id, promptContext });
  await markFixed(projectId, [findingId]);
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
  const open = asFindings(row.findings).filter(
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
