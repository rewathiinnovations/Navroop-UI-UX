'use server';

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth';

function unauthorized() {
  return { ok: false as const, error: 'Sign in required', status: 401 };
}

function notFound() {
  return { ok: false as const, error: 'Project not found', status: 404 };
}

export async function toggleStar(projectId: string) {
  const user = await getSessionUser();
  if (!user) return unauthorized();

  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true },
  });
  if (!project) return notFound();

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
