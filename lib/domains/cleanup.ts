import { prisma } from '@/lib/db';
import { removeApplicationDomain } from '@/lib/coolify/client';
import { serverAuth } from '@/lib/coolify/servers';
import { deleteCustomDomainRow, listCustomDomainsForDeployment } from './store';

/** Remove hostnames from the Coolify app. Path B Cloudflare zones are never deleted. */
export async function removeDomainsForDeployment(deploymentId: string) {
  const deployment = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    include: { server: true },
  });
  const rows = await listCustomDomainsForDeployment(deploymentId);
  for (const row of rows) {
    if (deployment?.coolifyAppUuid) {
      try {
        await removeApplicationDomain(serverAuth(deployment.server), deployment.coolifyAppUuid, row.hostname);
      } catch (error) {
        console.warn('[domains] Coolify remove failed', row.id, error);
      }
    }
    if (row.path === 'B' && row.cloudflareZoneId) {
      console.warn('[domains] Path B zone kept (not deleted)', row.cloudflareZoneId, row.hostname);
    }
    await deleteCustomDomainRow(row.id);
  }
  return rows.length;
}

export async function removeDomainFromCoolify(input: {
  deploymentId: string;
  hostname: string;
}) {
  const deployment = await prisma.deployment.findUnique({
    where: { id: input.deploymentId },
    include: { server: true },
  });
  if (!deployment?.coolifyAppUuid) return;
  await removeApplicationDomain(serverAuth(deployment.server), deployment.coolifyAppUuid, input.hostname);
}
