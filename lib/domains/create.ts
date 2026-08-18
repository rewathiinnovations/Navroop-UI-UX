import { randomBytes } from 'node:crypto';
import { prisma } from '@/lib/db';
import { peekRootDomain } from '@/lib/integrations/store';
import { checkCustomDomainAllowed } from '@/lib/plans/limits';
import { createOrGetClientZone, upsertClientZoneRecord } from '@/lib/cloudflare/zones';
import type { CustomDomainPath, PublicCustomDomain } from './types';
import { isOurZone, normalizeHostname, zoneNameForHostname } from './hostname';
import { expectedTargetFor, publishedHostFor, toPublicCustomDomain } from './instructions';
import { DuplicateHostnameError, findCustomDomainByHostname, insertCustomDomain } from './store';

export type DomainActionErr = { ok: false; error: string; status: number };
export type DomainActionOk<T> = { ok: true; data: T };
export type DomainActionResult<T> = DomainActionOk<T> | DomainActionErr;

async function loadPublishedDeployment(projectId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true },
  });
  if (!project) return { ok: false as const, error: 'Project not found', status: 404 as const };
  const deployment = await prisma.deployment.findFirst({
    where: { projectId, kind: 'LIVE', status: { not: 'STOPPED' } },
    include: { server: true },
    orderBy: { createdAt: 'desc' },
  });
  if (!deployment) {
    return { ok: false as const, error: 'Publish the site first, then add a custom domain', status: 400 as const };
  }
  return { ok: true as const, deployment };
}

export async function createCustomDomain(input: {
  projectId: string;
  hostname: string;
  path: CustomDomainPath;
}): Promise<DomainActionResult<PublicCustomDomain>> {
  const hostname = normalizeHostname(input.hostname);
  if (!hostname) {
    return { ok: false, error: 'Enter a valid hostname such as example.com or www.example.com', status: 400 };
  }

  const loaded = await loadPublishedDeployment(input.projectId);
  if (!loaded.ok) return { ok: false, error: loaded.error, status: loaded.status };
  const { deployment } = loaded;

  const allowed = await checkCustomDomainAllowed(deployment.workspaceId);
  if (!allowed.ok) {
    return { ok: false, error: allowed.message, status: allowed.status };
  }

  const zone = await peekRootDomain(deployment.workspaceId);
  if (!zone) {
    return { ok: false, error: 'Cloudflare is not connected', status: 409 };
  }
  if (isOurZone(hostname, zone)) {
    return { ok: false, error: `This hostname is already on our zone (${zone})`, status: 400 };
  }

  const existing = await findCustomDomainByHostname(hostname);
  if (existing) {
    return { ok: false, error: `This hostname is already in use: ${hostname}`, status: 409 };
  }

  const expectedTarget = expectedTargetFor({
    hostname,
    serverIp: deployment.server.serverIp,
    slug: deployment.slug,
    kind: deployment.kind,
    zone,
  });
  const verifyToken = randomBytes(16).toString('hex');
  const path = input.path === 'B' ? 'B' : 'A';

  let cloudflareZoneId: string | null = null;
  let nameservers: string[] | null = null;
  if (path === 'B') {
    try {
      const zoneName = zoneNameForHostname(hostname);
      const created = await createOrGetClientZone(zoneName, deployment.workspaceId);
      cloudflareZoneId = created.zoneId;
      nameservers = created.nameservers.slice(0, 2);
      await upsertClientZoneRecord({
        workspaceId: deployment.workspaceId,
        zoneId: created.zoneId,
        type: expectedTarget.includes('.') && /[a-z]/i.test(expectedTarget) ? 'CNAME' : 'A',
        name: hostname,
        content: expectedTarget,
      });
      await upsertClientZoneRecord({
        workspaceId: deployment.workspaceId,
        zoneId: created.zoneId,
        type: 'TXT',
        name: `_navroop-verify.${hostname}`,
        content: verifyToken,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not add this hostname as a Cloudflare zone';
      return { ok: false, error: message, status: 502 };
    }
  }

  try {
    const row = await insertCustomDomain({
      deploymentId: deployment.id,
      workspaceId: deployment.workspaceId,
      hostname,
      verifyToken,
      expectedTarget,
      path,
      cloudflareZoneId,
      nameservers,
    });
    return {
      ok: true,
      data: toPublicCustomDomain(row, publishedHostFor({ slug: deployment.slug, kind: deployment.kind, zone })),
    };
  } catch (error) {
    if (error instanceof DuplicateHostnameError) {
      return { ok: false, error: error.message, status: 409 };
    }
    throw error;
  }
}
