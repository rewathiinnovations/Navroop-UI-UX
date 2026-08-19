import { prisma } from '@/lib/db';
import { removeApplicationDomain } from '@/lib/coolify/client';
import { serverAuth } from '@/lib/coolify/servers';
import { deleteCustomDomainRow, listCustomDomainsForDeployment } from './store';

/**
 * Remove hostnames from the Coolify app. Path B Cloudflare zones are never deleted.
 *
 * `deleteRows` defaults to true — destroying a deployment or purging a project really does
 * retire the hostnames. Stop and soft-delete are reversible, though, and they used to share
 * this routine: a Stop wiped hostname, verifyToken, expectedTarget, isPrimary and (Path B)
 * the only pointer to the client's Cloudflare zone, so a restore meant re-adding every
 * hostname and sitting through DNS verification again. Those callers pass false: the app
 * loses the hostname on Coolify, the rows survive byte-for-byte, and the next publish
 * re-attaches them.
 */
export async function removeDomainsForDeployment(
  deploymentId: string,
  opts?: { deleteRows?: boolean },
) {
  const deleteRows = opts?.deleteRows ?? true;
  const deployment = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    include: { server: true },
  });
  const rows = await listCustomDomainsForDeployment(deploymentId);
  for (const row of rows) {
    if (deployment?.coolifyAppUuid) {
      try {
        await removeApplicationDomain(
          serverAuth(deployment.server),
          deployment.coolifyAppUuid,
          row.hostname,
        );
      } catch (error) {
        console.warn('[domains] Coolify remove failed', row.id, error);
      }
    }
    if (!deleteRows) continue;
    if (row.path === 'B' && row.cloudflareZoneId) {
      console.warn('[domains] Path B zone kept (not deleted)', row.cloudflareZoneId, row.hostname);
    }
    await deleteCustomDomainRow(row.id);
  }
  return rows.length;
}

export async function removeDomainFromCoolify(input: { deploymentId: string; hostname: string }) {
  const deployment = await prisma.deployment.findUnique({
    where: { id: input.deploymentId },
    include: { server: true },
  });
  if (!deployment?.coolifyAppUuid) return;
  await removeApplicationDomain(
    serverAuth(deployment.server),
    deployment.coolifyAppUuid,
    input.hostname,
  );
}
