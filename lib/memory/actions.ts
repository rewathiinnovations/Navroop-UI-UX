'use server';

import { prisma } from '@/lib/db';
import { getSessionUser, type SessionUser } from '@/lib/auth';
import { peekActor } from '@/lib/projects/plan';
import { buildMemoryBlock } from './build-context';
import {
  createMemoryInputSchema,
  listMemoriesInputSchema,
  memoryIdSchema,
  parseWithZod,
  updateMemoryInputSchema,
} from './schema';
import { setMemoryExtractionEnabled, getMemoryExtractionEnabled } from './settings';
import type { MemoryCategory, MemoryScope, PublicMemory } from './types';

type ActionErr = { ok: false; error: string; status: number; details?: unknown };
type ActionOk<T> = { ok: true; data: T };
type ActionResult<T> = ActionOk<T> | ActionErr;

function unauthorized(): ActionErr {
  return { ok: false, error: 'Sign in required', status: 401 };
}

function notFound(): ActionErr {
  return { ok: false, error: 'Memory not found', status: 404 };
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
  scope: string;
  projectId: string | null;
  category: string;
  content: string;
  source: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): PublicMemory {
  return {
    id: row.id,
    scope: row.scope === 'WORKSPACE' ? 'WORKSPACE' : 'PROJECT',
    projectId: row.projectId,
    category: row.category as MemoryCategory,
    content: row.content,
    source: row.source === 'extracted' ? 'extracted' : 'manual',
    status: row.status === 'PENDING' ? 'PENDING' : row.status === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE',
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function canMutateScope(user: SessionUser, scope: MemoryScope, projectId: string | null) {
  if (scope === 'WORKSPACE') {
    return user.role === 'ADMIN';
  }
  if (!projectId) return false;
  if (user.role === 'ADMIN') return true;
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { ownerId: true },
  });
  return Boolean(project && project.ownerId === user.id);
}

export async function createMemory(input: unknown): Promise<ActionResult<PublicMemory>> {
  const { user, err } = await requireActor();
  if (!user) return err;
  const parsed = parseWithZod(createMemoryInputSchema, input);
  if (!parsed.ok) return parsed;

  const projectId = parsed.data.scope === 'WORKSPACE' ? null : parsed.data.projectId ?? null;
  if (!(await canMutateScope(user, parsed.data.scope, projectId))) return forbidden();

  if (parsed.data.scope === 'PROJECT' && projectId) {
    const project = await prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { id: true },
    });
    if (!project) return { ok: false, error: 'Project not found', status: 404 };
  }

  const created = await prisma.memoryEntry.create({
    data: {
      scope: parsed.data.scope,
      projectId,
      category: parsed.data.category,
      content: parsed.data.content,
      source: 'manual',
      status: 'ACTIVE',
      createdById: user.id,
    },
  });
  return { ok: true, data: toPublic(created) };
}

async function loadMutable(id: string, user: SessionUser) {
  const row = await prisma.memoryEntry.findUnique({ where: { id } });
  if (!row) return { row: null, err: notFound() as ActionErr };
  const scope = row.scope === 'WORKSPACE' ? 'WORKSPACE' : 'PROJECT';
  if (!(await canMutateScope(user, scope, row.projectId))) {
    return { row: null, err: forbidden() as ActionErr };
  }
  return { row, err: null };
}

export async function updateMemory(id: string, content: string): Promise<ActionResult<PublicMemory>> {
  const { user, err } = await requireActor();
  if (!user) return err;
  const parsed = parseWithZod(updateMemoryInputSchema, { id, content });
  if (!parsed.ok) return parsed;
  const loaded = await loadMutable(parsed.data.id, user);
  if (!loaded.row) return loaded.err;
  const updated = await prisma.memoryEntry.update({
    where: { id: loaded.row.id },
    data: { content: parsed.data.content },
  });
  return { ok: true, data: toPublic(updated) };
}

export async function archiveMemory(id: string): Promise<ActionResult<PublicMemory>> {
  const { user, err } = await requireActor();
  if (!user) return err;
  const parsed = parseWithZod(memoryIdSchema, { id });
  if (!parsed.ok) return parsed;
  const loaded = await loadMutable(parsed.data.id, user);
  if (!loaded.row) return loaded.err;
  const updated = await prisma.memoryEntry.update({
    where: { id: loaded.row.id },
    data: { status: 'ARCHIVED' },
  });
  return { ok: true, data: toPublic(updated) };
}

export async function reactivateMemory(id: string): Promise<ActionResult<PublicMemory>> {
  const { user, err } = await requireActor();
  if (!user) return err;
  const parsed = parseWithZod(memoryIdSchema, { id });
  if (!parsed.ok) return parsed;
  const loaded = await loadMutable(parsed.data.id, user);
  if (!loaded.row) return loaded.err;
  const updated = await prisma.memoryEntry.update({
    where: { id: loaded.row.id },
    data: { status: 'ACTIVE' },
  });
  return { ok: true, data: toPublic(updated) };
}

export async function listMemories(input: unknown): Promise<ActionResult<PublicMemory[]>> {
  const { user, err } = await requireActor();
  if (!user) return err;
  const parsed = parseWithZod(listMemoriesInputSchema, input);
  if (!parsed.ok) return parsed;

  const rows = await prisma.memoryEntry.findMany({
    where: {
      scope: parsed.data.scope,
      projectId: parsed.data.scope === 'WORKSPACE' ? null : parsed.data.projectId ?? undefined,
      status: { in: ['ACTIVE', 'PENDING'] },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
  });
  return { ok: true, data: rows.map(toPublic) };
}

export async function listBrainMemories(projectId: string): Promise<
  ActionResult<{ workspace: PublicMemory[]; project: PublicMemory[] }>
> {
  const { user, err } = await requireActor();
  if (!user) return err;
  if (!projectId.trim()) return { ok: false, error: 'projectId is required', status: 400 };

  const [workspace, project] = await Promise.all([
    prisma.memoryEntry.findMany({
      where: { scope: 'WORKSPACE', projectId: null, status: { in: ['ACTIVE', 'PENDING'] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    }),
    prisma.memoryEntry.findMany({
      where: { scope: 'PROJECT', projectId, status: { in: ['ACTIVE', 'PENDING'] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    }),
  ]);
  return {
    ok: true,
    data: { workspace: workspace.map(toPublic), project: project.map(toPublic) },
  };
}

export async function getMemoryBudget(projectId: string) {
  const { user, err } = await requireActor();
  if (!user) return err;
  const result = await buildMemoryBlock(projectId);
  return { ok: true as const, data: result };
}

export async function getMemoryExtractionSetting() {
  const { user, err } = await requireActor();
  if (!user) return err;
  if (user.role !== 'ADMIN') return forbidden();
  return { ok: true as const, data: { enabled: await getMemoryExtractionEnabled() } };
}

export async function updateMemoryExtractionSetting(enabled: boolean) {
  const { user, err } = await requireActor();
  if (!user) return err;
  if (user.role !== 'ADMIN') return forbidden();
  const next = await setMemoryExtractionEnabled(Boolean(enabled));
  return { ok: true as const, data: { enabled: next } };
}
