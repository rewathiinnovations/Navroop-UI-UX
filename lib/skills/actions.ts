'use server';

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth';
import { DEFAULT_SKILLS } from './defaults';
import {
  createSkillSchema,
  parseWithZod,
  skillIdSchema,
  updateSkillSchema,
  type SkillInput,
} from './schema';

type ActionErr = { ok: false; error: string; status: number; details?: unknown };
type ActionOk<T> = { ok: true; data: T };
type ActionResult<T> = ActionOk<T> | ActionErr;

export type PublicSkill = {
  id: string;
  name: string;
  description: string;
  content: string;
  enabled: boolean;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
};

function unauthorized(): ActionErr {
  return { ok: false, error: 'Sign in required', status: 401 };
}

function forbidden(): ActionErr {
  return { ok: false, error: 'Admin access required', status: 403 };
}

async function requireActor() {
  const user = await getSessionUser();
  if (!user) return { user: null, err: unauthorized() as ActionErr };
  return { user, err: null };
}

async function requireAdminActor() {
  const { user, err } = await requireActor();
  if (!user) return { user: null, err };
  if (user.role !== 'ADMIN') return { user: null, err: forbidden() };
  return { user, err: null };
}

function toPublic(row: {
  id: string;
  name: string;
  description: string;
  content: string;
  enabled: boolean;
  usageCount: number;
  createdAt: Date;
  updatedAt: Date;
}): PublicSkill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    content: row.content,
    enabled: row.enabled,
    usageCount: row.usageCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function seedDefaults(createdById: string) {
  const count = await prisma.skill.count();
  if (count > 0) return;
  await prisma.skill.createMany({
    data: DEFAULT_SKILLS.map((skill) => ({
      name: skill.name,
      description: skill.description,
      content: skill.content,
      enabled: true,
      createdById,
    })),
    skipDuplicates: true,
  });
}

export async function listSkills(): Promise<ActionResult<PublicSkill[]>> {
  const { user, err } = await requireActor();
  if (!user) return err;

  try {
    await seedDefaults(user.id);
  } catch {
    // Seed is best-effort; listing still proceeds.
  }

  const rows = await prisma.skill.findMany({
    orderBy: [{ usageCount: 'desc' }, { name: 'asc' }],
  });
  return { ok: true, data: rows.map(toPublic) };
}

export async function createSkill(input: SkillInput): Promise<ActionResult<PublicSkill>> {
  const { user, err } = await requireAdminActor();
  if (!user) return err;

  const parsed = parseWithZod(createSkillSchema, input);
  if (!parsed.ok) return parsed;

  try {
    const row = await prisma.skill.create({
      data: {
        ...parsed.data,
        enabled: true,
        createdById: user.id,
      },
    });
    return { ok: true, data: toPublic(row) };
  } catch {
    return { ok: false, error: 'A skill with that name already exists', status: 409 };
  }
}

export async function updateSkill(input: {
  id: string;
  name?: string;
  description?: string;
  content?: string;
}): Promise<ActionResult<PublicSkill>> {
  const { user, err } = await requireAdminActor();
  if (!user) return err;

  const parsed = parseWithZod(updateSkillSchema, input);
  if (!parsed.ok) return parsed;

  const existing = await prisma.skill.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return { ok: false, error: 'Skill not found', status: 404 };

  try {
    const row = await prisma.skill.update({
      where: { id: parsed.data.id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        ...(parsed.data.content !== undefined ? { content: parsed.data.content } : {}),
      },
    });
    return { ok: true, data: toPublic(row) };
  } catch {
    return { ok: false, error: 'A skill with that name already exists', status: 409 };
  }
}

export async function deleteSkill(id: string): Promise<ActionResult<{ id: string }>> {
  const { user, err } = await requireAdminActor();
  if (!user) return err;

  const parsed = parseWithZod(skillIdSchema, { id });
  if (!parsed.ok) return parsed;

  try {
    await prisma.skill.delete({ where: { id: parsed.data.id } });
    return { ok: true, data: { id: parsed.data.id } };
  } catch {
    return { ok: false, error: 'Skill not found', status: 404 };
  }
}

export async function toggleSkillEnabled(id: string): Promise<ActionResult<PublicSkill>> {
  const { user, err } = await requireAdminActor();
  if (!user) return err;

  const parsed = parseWithZod(skillIdSchema, { id });
  if (!parsed.ok) return parsed;

  const existing = await prisma.skill.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return { ok: false, error: 'Skill not found', status: 404 };

  const row = await prisma.skill.update({
    where: { id: parsed.data.id },
    data: { enabled: !existing.enabled },
  });
  return { ok: true, data: toPublic(row) };
}
