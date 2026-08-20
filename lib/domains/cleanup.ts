import { prisma } from '@/lib/db';
import { removeApplicationDomain } from '@/lib/coolify/client';
import { serverAuth } from '@/lib/coolify/servers';
import { log } from '@/lib/logger';
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
): Promise<{ removed: number; failures: Array<{ hostname: string; reason: string }> }> {
  const deleteRows = opts?.deleteRows ?? true;
  const deployment = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    include: { server: true },
  });
  const rows = await listCustomDomainsForDeployment(deploymentId);
  let removed = 0;
  const failures: Array<{ hostname: string; reason: string }> = [];
  for (const row of rows) {
    if (deployment?.coolifyAppUuid) {
      try {
        await removeApplicationDomain(
          serverAuth(deployment.server),
          deployment.coolifyAppUuid,
          row.hostname,
        );
      } catch (error) {
        // The detach failed, so the hostname is still attached to the Coolify app. The row is the
        // only thing naming it (removal is driven from the rows), so it must survive as the
        // receipt (F-222) — never delete it here, and report it so the caller can act.
        const reason = error instanceof Error ? error.message : String(error);
        log.warn('domains.detach_failed', { domainId: row.id, hostname: row.hostname, reason });
        failures.push({ hostname: row.hostname, reason });
        continue;
      }
    }
    if (!deleteRows) continue;
    if (row.path === 'B' && row.cloudflareZoneId) {
      log.warn('domains.path_b_zone_kept', {
        zoneId: row.cloudflareZoneId,
        hostname: row.hostname,
      });
    }
    await deleteCustomDomainRow(row.id);
    removed += 1;
  }
  return { removed, failures };
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
