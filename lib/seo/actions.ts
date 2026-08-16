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

function toPublic(row: { id: string; projectId: string; findings: unknown; scannedAt: Date }): PublicSeoAudit {
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
  if (!project) return;

  const previous = await latestRow(projectId);
  const files = await captureFileSnapshot(projectId);
  const previewUrl = project.previewUrl?.trim() || null;
  const live = previewUrl ? await fetchPreviewDocument(previewUrl) : null;
  const [liveRobots, liveSitemap] = previewUrl
    ? await Promise.all([fetchPreviewText(previewUrl, '/robots.txt'), fetchPreviewText(previewUrl, '/sitemap.xml')])
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

  if (!inflight.has(projectId)) {
    const job = performSeoAudit(projectId)
      .catch((error) => {
        console.warn('[seo] audit failed', error);
      })
      .finally(() => {
        inflight.delete(projectId);
      });
    inflight.set(projectId, job);
  }

  return { ok: true, data: { scanning: true } };
}

/** Any signed-in member. */
export async function getLatestSeoAudit(projectId: string): Promise<ActionResult<{
  audit: PublicSeoAudit | null;
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
  await markFixed(projectId, open.map((item) => item.id));
  return { ok: true, data: { promptContext, findingIds: open.map((item) => item.id) } };
}
