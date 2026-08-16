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
import { resolveSandboxRunner } from './sandbox';
import { runCodeScan } from './scan';
import type { PublicCodeAudit } from './types';
import { recordCodeAuditSignals } from '@/lib/signals/collect';

type ActionErr = { ok: false; error: string; status: number };
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
    select: { id: true, stack: true, previewUrl: true, sandboxId: true, designDirection: true },
  });
  if (!project) return;

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
  const scanned = await runCodeScan({
    stack,
    files,
    previewUrl: project.previewUrl?.trim() || null,
    sandbox: resolveSandboxRunner(project.sandboxId),
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

  if (!inflight.has(projectId)) {
    const job = performCodeAudit(projectId)
      .catch((error) => {
        console.warn('[audit] code audit failed', error);
      })
      .finally(() => {
        inflight.delete(projectId);
      });
    inflight.set(projectId, job);
  }

  return { ok: true, data: { scanning: true } };
}

/** Any signed-in member. */
export async function getLatestCodeAudit(projectId: string): Promise<ActionResult<{
  audit: PublicCodeAudit | null;
  scanning: boolean;
}>> {
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
  await markFixed(projectId, open.map((item) => item.id));
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
