'use server';

import { Prisma } from '@/generated/prisma';
import { prisma } from '@/lib/db';
import { getSessionUser, type SessionUser } from '@/lib/auth';
import {
  createProjectSchema,
  nameFromPrompt,
  parseWithZod,
  updateProjectSchema,
} from '@/lib/projects/schema';
import { applyCreateProjectPlanFlow, peekActor } from '@/lib/projects/plan';
import { buildProjectListQuery, type ListProjectsQuery } from '@/lib/projects/list-sql';
import { createCheckpointAfterGeneration } from '@/lib/checkpoints/actions';
import { extractMemoriesAfterGeneration } from '@/lib/memory/extract';
import { countVisualEditsFromSource, maybeSettleFollowups, recordVisualEditRate } from '@/lib/signals/collect';
import { decideUrlImportFlow } from '@/lib/import/pipeline';
import { upsertImportSource } from '@/lib/import/persist';
import { asCreditActionErr } from '@/lib/plans/http';
import { checkLimit } from '@/lib/plans/limits';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { bumpContentVersion } from '@/lib/projects/lock';
import { incrementUsageCount } from '@/lib/templates/usage';
import { writeAudit } from '@/lib/audit/log';
import { logError } from '@/lib/logger';
import { capturePreviewAfterGeneration } from '@/lib/preview/after-generation';

export type ActionOk<T> = { ok: true; data: T };
export type ActionErr = {
  ok: false;
  error: string;
  status: number;
  details?: unknown;
};
export type ActionResult<T> = ActionOk<T> | ActionErr;

const ownerSelect = { id: true, name: true, email: true, role: true } as const;
const listOwnerSelect = { name: true, avatarUrl: true } as const;

const LIST_SORTS = new Set(['updatedAt', 'name', 'createdAt']);

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

/**
 * Runs post-generation follow-up work without blocking the response, and without losing the
 * failure.
 *
 * Detached is deliberate: the generation already succeeded and none of this may fail the
 * request. `void promise` was not — a rejection became an unhandled rejection with no project
 * and no task name, which is how `maybeSettleFollowups` could fail to settle job state with
 * nothing to show for it. A synchronous throw inside the task is caught here too.
 */
function detachAfterGeneration(projectId: string, task: string, work: () => Promise<unknown>) {
  void (async () => {
    try {
      await work();
    } catch (error) {
      logError('projects.after_generation_failed', error, { projectId, task });
    }
  })();
}

async function requireUser() {
  const user = await getSessionUser();
  if (!user) return { user: null, err: unauthorized() as ActionErr };
  return { user, err: null };
}

function copyName(name: string) {
  const next = `${name} (copy)`;
  return next.length > 100 ? next.slice(0, 100) : next;
}

/** Single insert path for dashboard, persist-client, and post-auth pending-prompt. */
export async function createProject(input: {
  name?: string;
  initialPrompt: string;
  skipPlanning?: boolean;
  stack?: string;
  designDirection?: string;
  importMode?: string;
  templateId?: string;
}) {
  const stored = peekActor();
  const actor = stored ? { user: stored, err: null as ActionErr | null } : await requireUser();
  if (!actor.user) return actor.err ?? unauthorized();
  const user = actor.user;

  const parsed = parseWithZod(createProjectSchema, input);
  if (!parsed.ok) return parsed;

  const projectLimit = await checkLimit(WORKSPACE_ROW_ID, 'projects');
  if (!projectLimit.ok) return asCreditActionErr(projectLimit);

  const flow = decideUrlImportFlow({
    initialPrompt: parsed.data.initialPrompt,
    skipPlanning: parsed.data.skipPlanning === true,
    importMode: parsed.data.importMode,
  });
  const skipPlanning = flow.skipPlanning;
  const name =
    typeof parsed.data.name === 'string' && parsed.data.name.trim()
      ? parsed.data.name.trim()
      : nameFromPrompt(parsed.data.initialPrompt);
  const project = await prisma.project.create({
    data: {
      name,
      initialPrompt: parsed.data.initialPrompt,
      ownerId: user.id,
      status: 'draft',
      generationStatus: flow.isUrlImport ? 'generating' : 'idle',
      progressMessage: flow.isUrlImport ? 'Capturing page…' : null,
      phase: skipPlanning ? 'BUILDING' : 'PLANNING',
      stack: parsed.data.stack,
      designDirection: parsed.data.designDirection,
    },
    include: { owner: { select: ownerSelect } },
  });

  if (flow.isUrlImport) {
    await upsertImportSource({
      projectId: project.id,
      sourceUrl: flow.sourceUrl,
      mode: flow.importMode,
    });
  }

  const { plan } = await applyCreateProjectPlanFlow({
    projectId: project.id,
    userId: user.id,
    initialPrompt: parsed.data.initialPrompt,
    skipPlanning,
  });

  if (parsed.data.templateId) {
    await incrementUsageCount(parsed.data.templateId);
  }

  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: 'project.create',
    targetType: 'project',
    targetId: project.id,
    after: { name: project.name, stack: project.stack },
  });

  return {
    ok: true as const,
    data: {
      id: project.id,
      initialPrompt: project.initialPrompt,
      name: project.name,
      phase: project.phase,
      stack: project.stack,
      designDirection: project.designDirection,
      urlImport: flow.isUrlImport,
      importMode: flow.isUrlImport ? flow.importMode : undefined,
      plan,
      project,
    },
  };
}

export async function listProjects(query: {
  search?: string;
  sort?: string;
  mine?: boolean;
  starred?: boolean;
}) {
  const { user, err } = await requireUser();
  if (!user) return err;

  const sort = LIST_SORTS.has(query.sort || '') ? query.sort! : 'updatedAt';
  const search = query.search?.trim();

  try {
    const rows = await prisma.project.findMany({
      where: {
        deletedAt: null,
        ...(query.mine === true ? { ownerId: user.id } : {}),
        ...(query.mine === false ? { ownerId: { not: user.id } } : {}),
        ...(query.starred ? { stars: { some: { userId: user.id } } } : {}),
        ...(search ? { name: { contains: search, mode: 'insensitive' as const } } : {}),
      },
      orderBy: sort === 'name' ? { name: 'asc' } : { [sort]: 'desc' },
      select: {
        id: true,
        name: true,
        thumbnailUrl: true,
        status: true,
        phase: true,
        createdAt: true,
        updatedAt: true,
        ownerId: true,
        owner: { select: listOwnerSelect },
        stars: { where: { userId: user.id }, select: { id: true } },
      },
    });

    const projects = rows.map(({ stars, ...project }) => ({
      ...project,
      starred: stars.length > 0,
    }));

    return { ok: true as const, data: { projects } };
  } catch {
    // Stale Prisma client (pre-phase/stars DMMF) still talks to the current DB.
    try {
      const projects = await listProjectsFromSql({
        userId: user.id,
        sort,
        search,
        mine: query.mine,
        starred: query.starred === true,
      });
      return { ok: true as const, data: { projects } };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not load projects';
      return { ok: false as const, error: message, status: 500 };
    }
  }
}

type ListProjectRow = {
  id: string;
  name: string;
  thumbnailUrl: string | null;
  status: string;
  phase: 'PLANNING' | 'BUILDING' | 'COMPLETE' | null;
  createdAt: Date;
  updatedAt: Date;
  ownerId: string;
  ownerName: string | null;
  ownerAvatarUrl: string | null;
  starred: boolean;
};

async function listProjectsFromSql(query: ListProjectsQuery) {
  const { sql, values } = buildProjectListQuery(query);
  const rows = await prisma.$queryRawUnsafe<ListProjectRow[]>(sql, ...values);

  const mapped = rows.map((row) => ({
    id: row.id,
    name: row.name,
    thumbnailUrl: row.thumbnailUrl,
    status: row.status,
    phase: row.phase,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ownerId: row.ownerId,
    owner: { name: row.ownerName, avatarUrl: row.ownerAvatarUrl },
    starred: Boolean(row.starred),
    liveUrl: null as string | null,
    previewUrl: null as string | null,
    publishBadge: 'draft' as 'draft' | 'preview' | 'live',
  }));

  if (mapped.length === 0) return mapped;
  try {
    const deployments = await prisma.deployment.findMany({
      where: { projectId: { in: mapped.map((row) => row.id) }, status: 'LIVE' },
      select: { projectId: true, kind: true, url: true },
    });
    const byProject = new Map<string, { liveUrl: string | null; previewUrl: string | null }>();
    for (const row of deployments) {
      const current = byProject.get(row.projectId) ?? { liveUrl: null, previewUrl: null };
      if (row.kind === 'LIVE') current.liveUrl = row.url;
      if (row.kind === 'PREVIEW') current.previewUrl = row.url;
      byProject.set(row.projectId, current);
    }
    return mapped.map((project) => {
      const urls = byProject.get(project.id);
      const publishBadge = urls?.liveUrl ? 'live' : urls?.previewUrl ? 'preview' : 'draft';
      return { ...project, liveUrl: urls?.liveUrl ?? null, previewUrl: urls?.previewUrl ?? null, publishBadge };
    });
  } catch {
    return mapped;
  }
}

export async function getProject(id: string) {
  const { user, err } = await requireUser();
  if (!user) return err;

  const project = await prisma.project.findFirst({
    where: { id, deletedAt: null },
    include: { owner: { select: ownerSelect }, importSource: true },
  });

  if (!project) return { ok: true as const, data: null };
  return { ok: true as const, data: project };
}

export async function updateProject(id: string, input: { name?: string; status?: string }) {
  const { user, err } = await requireUser();
  if (!user) return err;

  const parsed = parseWithZod(updateProjectSchema, input);
  if (!parsed.ok) return parsed;

  const existing = await prisma.project.findFirst({
    where: { id, deletedAt: null },
    select: { ownerId: true },
  });
  if (!existing) return notFound();
  if (!canMutate(user, existing.ownerId)) return forbidden();

  const project = await prisma.project.update({
    where: { id },
    data: {
      ...(typeof parsed.data.name === 'string' ? { name: parsed.data.name } : {}),
      ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
    },
    include: { owner: { select: ownerSelect } },
  });

  return { ok: true as const, data: project };
}

export async function deleteProject(id: string) {
  const { user, err } = await requireUser();
  if (!user) return err;

  const existing = await prisma.project.findFirst({
    where: { id, deletedAt: null },
    select: { ownerId: true },
  });
  if (!existing) return notFound();
  if (!canMutate(user, existing.ownerId)) return forbidden();

  const project = await prisma.project.update({
    where: { id },
    data: { deletedAt: new Date() },
    include: { owner: { select: ownerSelect } },
  });

  try {
    const { stopProjectDeployments } = await import('@/lib/publish/cleanup');
    await stopProjectDeployments(id);
  } catch (error) {
    console.warn('[projects] stop deployments on soft-delete failed', id, error);
  }

  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: 'project.soft_delete',
    targetType: 'project',
    targetId: id,
  });

  return { ok: true as const, data: project };
}

export async function restoreProject(id: string) {
  const { user, err } = await requireUser();
  if (!user) return err;

  const existing = await prisma.project.findUnique({
    where: { id },
    select: { ownerId: true },
  });
  if (!existing) return notFound();
  if (!canMutate(user, existing.ownerId)) return forbidden();

  const project = await prisma.project.update({
    where: { id },
    data: { deletedAt: null },
    include: { owner: { select: ownerSelect } },
  });

  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: 'project.restore',
    targetType: 'project',
    targetId: id,
  });

  return { ok: true as const, data: project };
}

export async function duplicateProject(id: string) {
  const { user, err } = await requireUser();
  if (!user) return err;

  const source = await prisma.project.findFirst({
    where: { id, deletedAt: null },
    select: { name: true, initialPrompt: true, ownerId: true, stack: true, designDirection: true },
  });
  if (!source) return notFound();
  if (!canMutate(user, source.ownerId)) return forbidden();

  const projectLimit = await checkLimit(WORKSPACE_ROW_ID, 'projects');
  if (!projectLimit.ok) return asCreditActionErr(projectLimit);

  // TODO: does not copy sandbox/generated code.
  const project = await prisma.project.create({
    data: {
      name: copyName(source.name),
      initialPrompt: source.initialPrompt,
      ownerId: user.id,
      status: 'draft',
      generationStatus: 'idle',
      stack: source.stack,
      designDirection: source.designDirection,
    },
    include: { owner: { select: ownerSelect } },
  });

  return { ok: true as const, data: project };
}

export type GenerationPersistInput = {
  style?: string | null;
  model?: string | null;
  sandboxId?: string | null;
  previewUrl?: string | null;
  thumbnailUrl?: string | null;
  lastCode?: string | null;
  generationStatus?: string | null;
  progressMessage?: string | null;
  sourceMessage?: string | null;
  source?: string | null;
};

export async function persistProjectGeneration(id: string, input: GenerationPersistInput) {
  const stored = peekActor();
  const actor = stored ? { user: stored, err: null as ActionErr | null } : await requireUser();
  if (!actor.user) return actor.err ?? unauthorized();
  const user = actor.user;

  const existing = await prisma.project.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, phase: true },
  });
  if (!existing) return notFound();

  const project = await prisma.project.update({
    where: { id },
    data: {
      ...(input.style !== undefined ? { style: input.style } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.sandboxId !== undefined ? { sandboxId: input.sandboxId } : {}),
      ...(input.previewUrl !== undefined ? { previewUrl: input.previewUrl } : {}),
      ...(input.thumbnailUrl !== undefined ? { thumbnailUrl: input.thumbnailUrl } : {}),
      ...(input.lastCode !== undefined ? { lastCode: input.lastCode } : {}),
      ...(input.generationStatus !== undefined && input.generationStatus
        ? { generationStatus: input.generationStatus }
        : {}),
      ...(input.progressMessage !== undefined ? { progressMessage: input.progressMessage } : {}),
      ...(existing.phase === 'BUILDING' && input.generationStatus === 'ready'
        ? { phase: 'COMPLETE' as const }
        : {}),
    },
    include: { owner: { select: ownerSelect } },
  });

  let previewNotice: string | null = null;
  if (input.generationStatus === 'ready') {
    await bumpContentVersion(id);
    try {
      const checkpoint = await createCheckpointAfterGeneration(id, {
        previousPhase: existing.phase,
        previewUrl: input.previewUrl ?? project.previewUrl,
        sourceMessage: input.sourceMessage,
      });
      if (checkpoint?.id) {
        const captured = await capturePreviewAfterGeneration(
          async () => {
            const { buildPreviewForProject } = await import('@/lib/preview/production');
            return buildPreviewForProject(id, checkpoint.id);
          },
          {
            projectId: id,
            checkpointId: checkpoint.id,
            checkpointCreatedAt: checkpoint.createdAt,
            findExisting: async () => {
              const { previewBuildTable } = await import('@/lib/preview/db');
              return previewBuildTable().findFirst({
                where: {
                  projectId: id,
                  checkpointId: checkpoint.id,
                  status: { in: ['READY', 'BUILDING'] },
                },
                orderBy: { createdAt: 'desc' },
              });
            },
          },
        );
        previewNotice = captured.notice;
        if (captured.error) {
          logError('projects.preview_after_generation_failed', captured.error, { projectId: id });
        } else if (captured.notice) {
          logError('projects.preview_after_generation_failed', new Error(captured.notice), {
            projectId: id,
          });
        }
      }
    } catch (error) {
      console.error('[checkpoints] create after generation failed', error);
    }
    detachAfterGeneration(id, 'visual_edit_rate', () =>
      recordVisualEditRate(id, countVisualEditsFromSource(input.source, input.sourceMessage)),
    );
    detachAfterGeneration(id, 'settle_followups', () => maybeSettleFollowups(id));
    detachAfterGeneration(id, 'extract_memories', () =>
      extractMemoriesAfterGeneration(id, { sourceMessage: input.sourceMessage }),
    );
  }

  return { ok: true as const, data: project, previewNotice };
}
