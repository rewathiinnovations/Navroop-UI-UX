import { prisma } from '@/lib/db';
import { peekRootDomain } from '@/lib/integrations/store';
import { checkCustomDomainAllowed } from '@/lib/plans/limits';
import { CUSTOM_DOMAIN_LOCKED_MESSAGE, type PublicCustomDomain } from './types';
import { publishedHostFor, toPublicCustomDomain, withoutVerifyToken } from './instructions';
import { listCustomDomainsForProject } from './store';

/** `canMutate` is required, not optional: the listing is readable workspace-wide, so the
 *  caller has to state whether this viewer may hold the domains' verify tokens. */
export async function getProjectDomainState(projectId: string, viewer: { canMutate: boolean }) {
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
  const zone = deployment
    ? await peekRootDomain(deployment.workspaceId)
    : await peekRootDomain(workspaceId);
  const rows = await listCustomDomainsForProject(projectId);
  const publishedHost =
    deployment && zone
      ? publishedHostFor({ slug: deployment.slug, kind: deployment.kind, zone })
      : '';
  const domains: PublicCustomDomain[] = rows.map((row) => {
    const domain = toPublicCustomDomain(row, publishedHost);
    return viewer.canMutate ? domain : withoutVerifyToken(domain);
  });

  return {
    ok: true as const,
    data: {
      allowed: allowed.ok,
      lockMessage: allowed.ok ? null : CUSTOM_DOMAIN_LOCKED_MESSAGE,
      published: Boolean(deployment),
      ourZone: zone,
      publishedHost,
      domains,
    },
  };
}
