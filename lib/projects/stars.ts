'use server';

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth';
import { canMutateOwned as canMutate } from '@/lib/auth/ownership';

function unauthorized() {
  return { ok: false as const, error: 'Sign in required', status: 401 };
}

function notFound() {
  return { ok: false as const, error: 'Project not found', status: 404 };
}

function forbidden() {
  return { ok: false as const, error: 'Forbidden', status: 403 };
}

/**
 * A star is per user — the row is keyed `(userId, projectId)` — but it is still a write
 * against someone else's project, so it is gated like every other mutation in
 * `lib/projects/*`: owner or ADMIN. Without it any signed-in member could probe project
 * ids and leave rows on projects never shared with them (F-402).
 */
export async function toggleStar(projectId: string) {
  const user = await getSessionUser();
  if (!user) return unauthorized();

  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { ownerId: true },
  });
  if (!project) return notFound();
  if (!canMutate(user, project.ownerId)) return forbidden();

  const existing = await prisma.projectStar.findUnique({
    where: { userId_projectId: { userId: user.id, projectId } },
  });

  if (existing) {
    await prisma.projectStar.delete({ where: { id: existing.id } });
    return { ok: true as const, data: { starred: false } };
  }

  await prisma.projectStar.create({
    data: { userId: user.id, projectId },
  });
  return { ok: true as const, data: { starred: true } };
}

export async function getRecentProjects(limit = 5) {
  const user = await getSessionUser();
  if (!user) return unauthorized();

  const projects = await prisma.project.findMany({
    where: { deletedAt: null },
    orderBy: { updatedAt: 'desc' },
    take: limit,
    select: { id: true, name: true, updatedAt: true },
  });

  return { ok: true as const, data: { projects } };
}

export async function getWorkspaceMeta() {
  const user = await getSessionUser();
  if (!user) return unauthorized();

  const memberCount = await prisma.user.count();
  const teamName = process.env.NEXT_PUBLIC_WORKSPACE_NAME || 'Navroop';
  return { ok: true as const, data: { memberCount, teamName } };
}
