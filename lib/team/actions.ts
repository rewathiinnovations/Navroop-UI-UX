'use server';

import { Prisma } from '@/generated/prisma';
import { prisma } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import { wouldRemoveLastAdmin } from '@/lib/team/last-admin';
import {
  memberIdSchema,
  parseWithZod,
  updateMemberRoleSchema,
  type TeamRole,
} from '@/lib/team/schema';

export type ActionOk<T> = { ok: true; data: T };
export type ActionErr = {
  ok: false;
  error: string;
  status: number;
  details?: unknown;
};
export type ActionResult<T> = ActionOk<T> | ActionErr;

const LAST_ADMIN_ERROR = "Can't remove the last admin";

const memberSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  isActive: true,
  createdAt: true,
  _count: { select: { projects: true } },
} as const;

async function adminGate() {
  const result = await requireAdmin();
  if (!result.user) {
    return { user: null, err: { ok: false as const, error: result.error, status: result.status } };
  }
  return { user: result.user, err: null };
}

function notFound(): ActionErr {
  return { ok: false, error: 'User not found', status: 404 };
}

function lastAdminErr(): ActionErr {
  return { ok: false, error: LAST_ADMIN_ERROR, status: 400 };
}

async function loadMember(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: memberSelect,
  });
}

// TODO: email invites are out of scope (self-serve registration).

export async function listTeam() {
  const { err } = await adminGate();
  if (err) return err;

  const members = await prisma.user.findMany({
    orderBy: { createdAt: 'asc' },
    select: memberSelect,
  });
  return { ok: true as const, data: { members } };
}

export async function updateMemberRole(userId: string, role: TeamRole) {
  const { err } = await adminGate();
  if (err) return err;

  const parsed = parseWithZod(updateMemberRoleSchema, { userId, role });
  if (!parsed.ok) return parsed;

  const existing = await loadMember(parsed.data.userId);
  if (!existing) return notFound();

  if (await wouldRemoveLastAdmin(parsed.data.userId, parsed.data.role)) {
    return lastAdminErr();
  }

  try {
    const member = await prisma.user.update({
      where: { id: parsed.data.userId },
      data: { role: parsed.data.role },
      select: memberSelect,
    });
    return { ok: true as const, data: member };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      return notFound();
    }
    throw error;
  }
}

export async function deactivateMember(userId: string) {
  const { err } = await adminGate();
  if (err) return err;

  const parsed = parseWithZod(memberIdSchema, { userId });
  if (!parsed.ok) return parsed;

  const existing = await loadMember(parsed.data.userId);
  if (!existing) return notFound();

  if (await wouldRemoveLastAdmin(parsed.data.userId, false)) {
    return lastAdminErr();
  }

  const member = await prisma.user.update({
    where: { id: parsed.data.userId },
    data: { isActive: false },
    select: memberSelect,
  });
  return { ok: true as const, data: member };
}

export async function reactivateMember(userId: string) {
  const { err } = await adminGate();
  if (err) return err;

  const parsed = parseWithZod(memberIdSchema, { userId });
  if (!parsed.ok) return parsed;

  const existing = await loadMember(parsed.data.userId);
  if (!existing) return notFound();

  const member = await prisma.user.update({
    where: { id: parsed.data.userId },
    data: { isActive: true },
    select: memberSelect,
  });
  return { ok: true as const, data: member };
}
