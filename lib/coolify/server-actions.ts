'use server';

import { requireAdmin } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { publicServer, testStoredServer } from './servers';

export async function listCoolifyServers() {
  const { user, error, status } = await requireAdmin();
  if (!user) return { ok: false as const, error, status };
  const rows = await prisma.coolifyServer.findMany({
    include: {
      _count: {
        select: { deployments: { where: { status: { not: 'STOPPED' } } } },
      },
    },
    orderBy: { createdAt: 'asc' },
  });
  return { ok: true as const, data: { servers: rows.map(publicServer) } };
}

export async function createCoolifyServer() {
  const { user, error, status } = await requireAdmin();
  if (!user) return { ok: false as const, error, status };
  return {
    ok: false as const,
    error: 'Servers come from /admin/integrations',
    status: 410 as const,
  };
}

export async function updateCoolifyServer(
  id: string,
  input: {
    isActive?: boolean;
    maxDeployments?: number;
  },
) {
  const { user, error, status } = await requireAdmin();
  if (!user) return { ok: false as const, error, status };
  const existing = await prisma.coolifyServer.findUnique({
    where: { id },
    include: { _count: { select: { deployments: { where: { status: { not: 'STOPPED' } } } } } },
  });
  if (!existing) return { ok: false as const, error: 'Server not found', status: 404 as const };

  if (input.isActive === false && existing._count.deployments > 0) {
    return {
      ok: false as const,
      error: `This server has ${existing._count.deployments} live deployments. Stop or move them first, or confirm to deactivate.`,
      status: 409 as const,
      needsConfirm: true,
      liveCount: existing._count.deployments,
    };
  }

  const row = await prisma.coolifyServer.update({
    where: { id },
    data: {
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.maxDeployments !== undefined ? { maxDeployments: input.maxDeployments } : {}),
    },
    include: { _count: { select: { deployments: { where: { status: { not: 'STOPPED' } } } } } },
  });
  return { ok: true as const, data: publicServer(row) };
}

export async function forceDeactivateServer(id: string) {
  const { user, error, status } = await requireAdmin();
  if (!user) return { ok: false as const, error, status };
  const row = await prisma.coolifyServer.update({
    where: { id },
    data: { isActive: false },
    include: { _count: { select: { deployments: { where: { status: { not: 'STOPPED' } } } } } },
  });
  return { ok: true as const, data: publicServer(row) };
}

export async function deleteCoolifyServer(id: string) {
  const { user, error, status } = await requireAdmin();
  if (!user) return { ok: false as const, error, status };
  const existing = await prisma.coolifyServer.findUnique({
    where: { id },
    include: { _count: { select: { deployments: true } } },
  });
  if (!existing) return { ok: false as const, error: 'Server not found', status: 404 as const };
  if (existing._count.deployments > 0) {
    return { ok: false as const, error: 'Cannot delete a server that still has deployments', status: 409 as const };
  }
  await prisma.coolifyServer.delete({ where: { id } });
  return { ok: true as const, data: { id } };
}

export async function testCoolifyServerAction(id: string) {
  const { user, error, status } = await requireAdmin();
  if (!user) return { ok: false as const, error, status };
  const result = await testStoredServer(id);
  if (!result.ok) return { ok: false as const, error: result.error, status: result.status || 502 };
  return { ok: true as const, data: result };
}
