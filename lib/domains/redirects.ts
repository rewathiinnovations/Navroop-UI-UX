import { prisma } from '@/lib/db';
import { peekRootDomain } from '@/lib/integrations/store';
import { serverAuth } from '@/lib/coolify/servers';
import { setApplicationPrimaryRedirects } from '@/lib/coolify/client';
import { hostForSlug } from '@/lib/publish/slug';
import { listCustomDomainsForDeployment } from './store';

function pairHost(hostname: string) {
  if (hostname.startsWith('www.')) return hostname.slice(4);
  if (hostname.split('.').length === 2) return `www.${hostname}`;
  return null;
}

export async function applyPrimaryRedirects(deploymentId: string) {
  const deployment = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    include: { server: true },
  });
  if (!deployment?.coolifyAppUuid) return;
  const zone = await peekRootDomain(deployment.workspaceId);
  const domains = await listCustomDomainsForDeployment(deploymentId);
  const primary = domains.find((row) => row.isPrimary && row.status === 'ACTIVE') ?? domains.find((row) => row.status === 'ACTIVE');
  if (!primary) return;

  const aliases = new Set<string>();
  if (zone) aliases.add(hostForSlug(deployment.slug, deployment.kind, zone));
  for (const row of domains) {
    if (row.id === primary.id) continue;
    if (row.status === 'ACTIVE' || row.status === 'SSL_PENDING') aliases.add(row.hostname);
  }
  const pair = pairHost(primary.hostname);
  if (pair) aliases.add(pair);

  await setApplicationPrimaryRedirects(
    serverAuth(deployment.server),
    deployment.coolifyAppUuid,
    primary.hostname,
    [...aliases],
  );
}
