import { prisma } from '@/lib/db';
import { deleteApplication, stopApplication } from '@/lib/coolify/client';
import { serverAuth } from '@/lib/coolify/servers';
import { deleteRecord } from '@/lib/cloudflare/dns';
import { deleteDeployRepo } from '@/lib/github/deploy-client';
import { removeDomainsForDeployment } from '@/lib/domains/cleanup';
import { DEFAULT_WORKSPACE_ID } from './constants';

async function withServer(serverId: string) {
  const server = await prisma.coolifyServer.findUnique({ where: { id: serverId } });
  if (!server) return null;
  return { server, auth: serverAuth(server) };
}

export async function stopProjectDeployments(projectId: string) {
  const rows = await prisma.deployment.findMany({
    where: { projectId, status: { not: 'STOPPED' } },
  });
  for (const row of rows) {
    try {
      await removeDomainsForDeployment(row.id);
    } catch (error) {
      console.warn('[publish] custom domain cleanup failed', row.id, error);
    }
    if (row.coolifyAppUuid) {
      const ctx = await withServer(row.serverId);
      if (ctx) {
        try {
          await stopApplication(ctx.auth, row.coolifyAppUuid);
        } catch (error) {
          console.warn('[publish] stop failed', row.id, error);
        }
      }
    }
    await prisma.deployment.update({
      where: { id: row.id },
      data: { status: 'STOPPED' },
    });
  }
  return rows.length;
}

export async function destroyDeployment(id: string, opts?: { deleteRepo?: boolean }) {
  const row = await prisma.deployment.findUnique({ where: { id } });
  if (!row) return null;

  try {
    await removeDomainsForDeployment(row.id);
  } catch (error) {
    console.warn('[publish] custom domain cleanup failed', row.id, error);
  }

  const ctx = row.coolifyAppUuid ? await withServer(row.serverId) : null;
  if (ctx && row.coolifyAppUuid) {
    try {
      await deleteApplication(ctx.auth, row.coolifyAppUuid);
    } catch (error) {
      console.warn('[publish] delete Coolify app failed', row.id, error);
    }
  }
  if (row.dnsRecordId) {
    try {
      await deleteRecord(row.dnsRecordId);
    } catch (error) {
      console.warn('[publish] delete DNS failed', row.id, error);
    }
  }
  if (opts?.deleteRepo !== false && row.repoFullName) {
    try {
      await deleteDeployRepo(row.repoFullName, row.workspaceId || DEFAULT_WORKSPACE_ID);
    } catch (error) {
      console.warn('[publish] delete deploy repo failed', row.id, error);
    }
  }

  await prisma.deployment.delete({ where: { id: row.id } });
  return row;
}

export async function purgeProjectPublishResources(projectId: string) {
  const rows = await prisma.deployment.findMany({ where: { projectId } });
  for (const row of rows) {
    await destroyDeployment(row.id, { deleteRepo: true });
  }
  return rows.length;
}

export async function stopDeployment(id: string) {
  const row = await prisma.deployment.findUnique({ where: { id } });
  if (!row) throw new Error('Deployment not found');
  try {
    await removeDomainsForDeployment(row.id);
  } catch (error) {
    console.warn('[publish] custom domain cleanup failed', row.id, error);
  }
  if (row.coolifyAppUuid) {
    const ctx = await withServer(row.serverId);
    if (ctx) await stopApplication(ctx.auth, row.coolifyAppUuid);
  }
  return prisma.deployment.update({
    where: { id },
    data: { status: 'STOPPED' },
  });
}
