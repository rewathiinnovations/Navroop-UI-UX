'use server';

import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { createCustomDomain, type DomainActionResult } from './create';
import { getProjectDomainState } from './list';
import { emailDomainInstructions } from './notify';
import { applyPrimaryRedirects } from './redirects';
import { removeDomainFromCoolify } from './cleanup';
import { checkDomain } from './verify';
import { buildDnsInstructions } from './instructions';
import {
  clearPrimaryForDeployment,
  deleteCustomDomainRow,
  findCustomDomain,
  updateCustomDomain,
} from './store';
import type { CustomDomainPath, PublicCustomDomain } from './types';
import { toPublicCustomDomain, publishedHostFor } from './instructions';
import { peekRootDomain } from '@/lib/integrations/store';
import { writeAudit } from '@/lib/audit/log';

function canMutate(user: { id: string; role: string }, ownerId: string) {
  return user.id === ownerId || user.role === 'ADMIN';
}

async function loadProject(projectId: string, mutate: boolean) {
  const user = await getSessionUser();
  if (!user) return { ok: false as const, error: 'Sign in required' as const, status: 401 as const };
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, ownerId: true },
  });
  if (!project) return { ok: false as const, error: 'Project not found' as const, status: 404 as const };
  if (mutate && !canMutate(user, project.ownerId)) {
    return { ok: false as const, error: 'Forbidden' as const, status: 403 as const };
  }
  return { ok: true as const, user, project };
}

async function asPublic(id: string): Promise<PublicCustomDomain | null> {
  const row = await findCustomDomain(id);
  if (!row) return null;
  const deployment = await prisma.deployment.findUnique({ where: { id: row.deploymentId } });
  const zone = deployment ? await peekRootDomain(deployment.workspaceId) : null;
  const publishedHost =
    deployment && zone ? publishedHostFor({ slug: deployment.slug, kind: deployment.kind, zone }) : '';
  return toPublicCustomDomain(row, publishedHost);
}

export async function listProjectDomains(projectId: string) {
  const loaded = await loadProject(projectId, false);
  if (!loaded.ok) return { ok: false as const, error: loaded.error, status: loaded.status };
  return getProjectDomainState(projectId);
}

export async function addProjectDomain(
  projectId: string,
  input: { hostname: string; path: CustomDomainPath },
): Promise<DomainActionResult<PublicCustomDomain>> {
  const loaded = await loadProject(projectId, true);
  if (!loaded.ok) return { ok: false, error: loaded.error, status: loaded.status };
  const created = await createCustomDomain({ projectId, hostname: input.hostname, path: input.path });
  if (created.ok) {
    await writeAudit({
      actorId: loaded.user.id,
      actorEmail: loaded.user.email,
      action: 'domain.add',
      targetType: 'custom_domain',
      targetId: created.data.id,
      after: { hostname: created.data.hostname, path: input.path },
    });
  }
  return created;
}

export async function checkProjectDomain(projectId: string, domainId: string) {
  const loaded = await loadProject(projectId, true);
  if (!loaded.ok) return { ok: false as const, error: loaded.error, status: loaded.status };
  const row = await findCustomDomain(domainId);
  if (!row) return { ok: false as const, error: 'Domain not found', status: 404 as const };
  const { withRecordedJob } = await import('@/lib/jobs/wrap');
  await withRecordedJob(
    {
      projectId,
      userId: loaded.user.id,
      kind: 'DOMAIN_VERIFY',
      inputPrompt: row.hostname,
    },
    async () => {
      await checkDomain(domainId);
    },
  );
  const data = await asPublic(domainId);
  if (!data) return { ok: false as const, error: 'Domain not found', status: 404 as const };
  return { ok: true as const, data };
}

export async function makeProjectDomainPrimary(projectId: string, domainId: string) {
  const loaded = await loadProject(projectId, true);
  if (!loaded.ok) return { ok: false as const, error: loaded.error, status: loaded.status };
  const row = await findCustomDomain(domainId);
  if (!row) return { ok: false as const, error: 'Domain not found', status: 404 as const };
  if (row.status !== 'ACTIVE') {
    return { ok: false as const, error: 'Only a live domain can be primary', status: 400 as const };
  }
  await clearPrimaryForDeployment(row.deploymentId, row.id);
  await updateCustomDomain(row.id, { isPrimary: true });
  try {
    await applyPrimaryRedirects(row.deploymentId);
  } catch (error) {
    console.warn('[domains] primary redirect failed', domainId, error);
  }
  const data = await asPublic(domainId);
  if (!data) return { ok: false as const, error: 'Domain not found', status: 404 as const };
  return { ok: true as const, data };
}

export async function removeProjectDomain(
  projectId: string,
  domainId: string,
  confirmHostname?: string,
) {
  const loaded = await loadProject(projectId, true);
  if (!loaded.ok) return { ok: false as const, error: loaded.error, status: loaded.status };
  const row = await findCustomDomain(domainId);
  if (!row) return { ok: false as const, error: 'Domain not found', status: 404 as const };
  if (row.path === 'B') {
    const typed = String(confirmHostname || '').trim().toLowerCase();
    if (typed !== row.hostname) {
      return {
        ok: false as const,
        error: `Type ${row.hostname} to confirm. The Cloudflare zone will not be deleted.`,
        status: 400 as const,
      };
    }
  }
  try {
    await removeDomainFromCoolify({ deploymentId: row.deploymentId, hostname: row.hostname });
  } catch (error) {
    console.warn('[domains] Coolify remove failed', domainId, error);
  }
  if (row.path === 'B' && row.cloudflareZoneId) {
    console.warn('[domains] Path B zone kept (not deleted)', row.cloudflareZoneId, row.hostname);
  }
  await deleteCustomDomainRow(row.id);
  await writeAudit({
    actorId: loaded.user.id,
    actorEmail: loaded.user.email,
    action: 'domain.remove',
    targetType: 'custom_domain',
    targetId: domainId,
    after: { hostname: row.hostname },
  });
  if (row.isPrimary) {
    try {
      await applyPrimaryRedirects(row.deploymentId);
    } catch {
      /* remaining domains may still be applied later */
    }
  }
  return { ok: true as const, data: { id: domainId } };
}

export async function emailProjectDomain(
  projectId: string,
  domainId: string,
  to: string,
) {
  const loaded = await loadProject(projectId, true);
  if (!loaded.ok) return { ok: false as const, error: loaded.error, status: loaded.status };
  const row = await findCustomDomain(domainId);
  if (!row) return { ok: false as const, error: 'Domain not found', status: 404 as const };
  const address = String(to || '').trim();
  if (!address.includes('@')) {
    return { ok: false as const, error: 'Enter a valid email address', status: 400 as const };
  }
  const result = await emailDomainInstructions({
    to: address,
    hostname: row.hostname,
    path: row.path,
    instructions: buildDnsInstructions(row),
  });
  if ('ok' in result && result.ok === false) {
    return { ok: false as const, error: result.error, status: 502 as const };
  }
  return { ok: true as const, data: { id: domainId } };
}
