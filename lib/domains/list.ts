import { prisma } from '@/lib/db';
import { peekRootDomain } from '@/lib/integrations/store';
import { checkCustomDomainAllowed } from '@/lib/plans/limits';
import { CUSTOM_DOMAIN_LOCKED_MESSAGE, type PublicCustomDomain } from './types';
import { publishedHostFor, toPublicCustomDomain } from './instructions';
import { listCustomDomainsForProject } from './store';

export async function getProjectDomainState(projectId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true },
  });
  if (!project) return { ok: false as const, error: 'Project not found', status: 404 as const };

  const deployment = await prisma.deployment.findFirst({
    where: { projectId, kind: 'LIVE', status: { not: 'STOPPED' } },
    orderBy: { createdAt: 'desc' },
  });
  const workspaceId = deployment?.workspaceId ?? 'default';
  const allowed = await checkCustomDomainAllowed(workspaceId);
  const zone = deployment ? await peekRootDomain(deployment.workspaceId) : await peekRootDomain(workspaceId);
  const rows = await listCustomDomainsForProject(projectId);
  const publishedHost = deployment && zone
    ? publishedHostFor({ slug: deployment.slug, kind: deployment.kind, zone })
    : '';

  return {
    ok: true as const,
    data: {
      allowed: allowed.ok,
      lockMessage: allowed.ok ? null : CUSTOM_DOMAIN_LOCKED_MESSAGE,
      published: Boolean(deployment),
      ourZone: zone,
      publishedHost,
      domains: rows.map((row) => toPublicCustomDomain(row, publishedHost)) as PublicCustomDomain[],
    },
  };
}
