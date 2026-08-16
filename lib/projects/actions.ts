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
import { createCheckpointAfterGeneration } from '@/lib/checkpoints/actions';

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
}) {
  const stored = peekActor();
  const { user, err } = stored ? { user: stored, err: null } : await requireUser();
  if (!user) return err;

  const parsed = parseWithZod(createProjectSchema, input);
  if (!parsed.ok) return parsed;

  const skipPlanning = parsed.data.skipPlanning === true;
  const name = parsed.data.name ?? nameFromPrompt(parsed.data.initialPrompt);
  const project = await prisma.project.create({
    data: {
      name,
      initialPrompt: parsed.data.initialPrompt,
      ownerId: user.id,
      status: 'draft',
      generationStatus: 'idle',
      phase: skipPlanning ? 'BUILDING' : 'PLANNING',
      stack: parsed.data.stack,
    },
    include: { owner: { select: ownerSelect } },
  });

  const { plan } = await applyCreateProjectPlanFlow({
    projectId: project.id,
    userId: user.id,
    initialPrompt: parsed.data.initialPrompt,
    skipPlanning,
  });

  return {
    ok: true as const,
    data: {
      id: project.id,
      initialPrompt: project.initialPrompt,
      name: project.name,
      phase: project.phase,
      stack: project.stack,
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

async function listProjectsFromSql(query: {
  userId: string;
  sort: string;
  search?: string;
  mine?: boolean;
  starred: boolean;
}) {
  const filters: Prisma.Sql[] = [Prisma.sql`p."deletedAt" IS NULL`];
  if (query.mine === true) filters.push(Prisma.sql`p."ownerId" = ${query.userId}`);
  if (query.mine === false) filters.push(Prisma.sql`p."ownerId" <> ${query.userId}`);
  if (query.search) filters.push(Prisma.sql`p.name ILIKE ${`%${query.search}%`}`);
  if (query.starred) {
    filters.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "ProjectStar" s WHERE s."projectId" = p.id AND s."userId" = ${query.userId})`,
    );
  }

  const orderBy =
    query.sort === 'name'
      ? Prisma.sql`p.name ASC`
      : query.sort === 'createdAt'
        ? Prisma.sql`p."createdAt" DESC`
        : Prisma.sql`p."updatedAt" DESC`;

  const rows = await prisma.$queryRaw<ListProjectRow[]>`
    SELECT
      p.id,
      p.name,
      p."thumbnailUrl",
      p.status,
      p.phase,
      p."createdAt",
      p."updatedAt",
      p."ownerId",
      u.name AS "ownerName",
      u."avatarUrl" AS "ownerAvatarUrl",
      EXISTS (
        SELECT 1 FROM "ProjectStar" s
        WHERE s."projectId" = p.id AND s."userId" = ${query.userId}
      ) AS starred
    FROM "Project" p
    INNER JOIN "User" u ON u.id = p."ownerId"
    WHERE ${Prisma.join(filters, ' AND ')}
    ORDER BY ${orderBy}
  `;

  return rows.map((row) => ({
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
  }));
}

export async function getProject(id: string) {
  const { user, err } = await requireUser();
  if (!user) return err;

  const project = await prisma.project.findFirst({
    where: { id, deletedAt: null },
    include: { owner: { select: ownerSelect } },
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
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
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

  return { ok: true as const, data: project };
}

export async function duplicateProject(id: string) {
  const { user, err } = await requireUser();
  if (!user) return err;

  const source = await prisma.project.findFirst({
    where: { id, deletedAt: null },
    select: { name: true, initialPrompt: true, ownerId: true, stack: true },
  });
  if (!source) return notFound();
  if (!canMutate(user, source.ownerId)) return forbidden();

  // TODO: does not copy sandbox/generated code.
  const project = await prisma.project.create({
    data: {
      name: copyName(source.name),
      initialPrompt: source.initialPrompt,
      ownerId: user.id,
      status: 'draft',
      generationStatus: 'idle',
      stack: source.stack,
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
};

export async function persistProjectGeneration(id: string, input: GenerationPersistInput) {
  const stored = peekActor();
  const { user, err } = stored ? { user: stored, err: null } : await requireUser();
  if (!user) return err;

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

  if (input.generationStatus === 'ready') {
    try {
      await createCheckpointAfterGeneration(id, {
        previousPhase: existing.phase,
        previewUrl: input.previewUrl ?? project.previewUrl,
        sourceMessage: input.sourceMessage,
      });
    } catch (error) {
      console.error('[checkpoints] create after generation failed', error);
    }
  }

  return { ok: true as const, data: project };
}
