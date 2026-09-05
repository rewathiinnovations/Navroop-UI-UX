'use server';

import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { createCustomDomain, type DomainActionResult } from './create';
import { getProjectDomainState } from './list';
import { emailDomainInstructions } from './notify';
import { applyPrimaryRedirects, type RedirectOutcome } from './redirects';
import { removeDomainFromCoolify } from './cleanup';
import { checkDomain } from './verify';
import { buildDnsInstructions } from './instructions';
import {
  clearPrimaryForDeployment,
  deleteCustomDomainRow,
  findCustomDomainForProject,
  updateCustomDomain,
} from './store';
import type { CustomDomainPath, PublicCustomDomain } from './types';
import { toPublicCustomDomain, publishedHostFor } from './instructions';
import { peekRootDomain } from '@/lib/integrations/store';
import { writeAudit } from '@/lib/audit/log';
import { log } from '@/lib/logger';
import { canMutateOwned as canMutate } from '@/lib/auth/ownership';

async function loadProject(projectId: string, mutate: boolean) {
  const user = await getSessionUser();
  if (!user)
    return { ok: false as const, error: 'Sign in required' as const, status: 401 as const };
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, ownerId: true },
  });
  if (!project)
    return { ok: false as const, error: 'Project not found' as const, status: 404 as const };
  if (mutate && !canMutate(user, project.ownerId)) {
    return { ok: false as const, error: 'Forbidden' as const, status: 403 as const };
  }
  return { ok: true as const, user, project };
}

async function asPublic(projectId: string, id: string): Promise<PublicCustomDomain | null> {
  const row = await findCustomDomainForProject(projectId, id);
  if (!row) return null;
  const deployment = await prisma.deployment.findUnique({ where: { id: row.deploymentId } });
  const zone = deployment ? await peekRootDomain(deployment.workspaceId) : null;
  const publishedHost =
    deployment && zone
      ? publishedHostFor({ slug: deployment.slug, kind: deployment.kind, zone })
      : '';
  return toPublicCustomDomain(row, publishedHost);
}

export async function listProjectDomains(projectId: string) {
  const loaded = await loadProject(projectId, false);
  if (!loaded.ok) return { ok: false as const, error: loaded.error, status: loaded.status };
  // Reads stay workspace-wide (see lib/auth/route-policy.ts); only the verify token is
  // held back from a viewer who could not mutate the domain anyway.
  return getProjectDomainState(projectId, {
    canMutate: canMutate(loaded.user, loaded.project.ownerId),
  });
}

export async function addProjectDomain(
  projectId: string,
  input: { hostname: string; path: CustomDomainPath },
): Promise<DomainActionResult<PublicCustomDomain>> {
  const loaded = await loadProject(projectId, true);
  if (!loaded.ok) return { ok: false, error: loaded.error, status: loaded.status };
  const created = await createCustomDomain({
    projectId,
    hostname: input.hostname,
    path: input.path,
  });
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
  const row = await findCustomDomainForProject(projectId, domainId);
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
  const data = await asPublic(projectId, domainId);
  if (!data) return { ok: false as const, error: 'Domain not found', status: 404 as const };
  return { ok: true as const, data };
}

export async function makeProjectDomainPrimary(projectId: string, domainId: string) {
  const loaded = await loadProject(projectId, true);
  if (!loaded.ok) return { ok: false as const, error: loaded.error, status: loaded.status };
  const row = await findCustomDomainForProject(projectId, domainId);
  if (!row) return { ok: false as const, error: 'Domain not found', status: 404 as const };
  if (row.status !== 'ACTIVE') {
    return { ok: false as const, error: 'Only a live domain can be primary', status: 400 as const };
  }
  await clearPrimaryForDeployment(row.deploymentId, row.id);
  await updateCustomDomain(row.id, { isPrimary: true });
  let redirects: RedirectOutcome = { ok: false, reason: 'Redirects were not attempted' };
  try {
    redirects = await applyPrimaryRedirects(row.deploymentId);
  } catch (error) {
    // The row is already primary; only the Coolify 301s are missing. Reported as a
    // structured event rather than a console line, because the fix is an operator action.
    log.warn('domains.primary_redirect_failed', {
      domainId,
      deploymentId: row.deploymentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  // A refusal is not a failed request: the row *is* primary now. But the user has to be told
  // the 301s did not follow, or they will keep reloading a hostname nothing redirects (F-207).
  // `applyPrimaryRedirects` has already written the reason to `lastError`, which `asPublic`
  // reads, so the payload below carries it — this only makes sure it is not silently dropped.
  if (!redirects.ok) {
    log.warn('domains.primary_redirect_incomplete', {
      domainId,
      deploymentId: row.deploymentId,
      reason: redirects.reason,
    });
  }
  const data = await asPublic(projectId, domainId);
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
  const row = await findCustomDomainForProject(projectId, domainId);
  if (!row) return { ok: false as const, error: 'Domain not found', status: 404 as const };
  if (row.path === 'B') {
    const typed = String(confirmHostname || '')
      .trim()
      .toLowerCase();
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
    // The detach failed, so the hostname is still served by Coolify. Keep the row as the surviving
    // receipt (F-222), do not write a `domain.remove` audit row as if it succeeded, and hand the
    // user an error they can act on.
    const reason = error instanceof Error ? error.message : String(error);
    log.warn('domains.detach_failed', { domainId, hostname: row.hostname, reason });
    return {
      ok: false as const,
      error: `Could not remove ${row.hostname} from the server: ${reason}. It is still on your list — try again.`,
      status: 502 as const,
    };
  }
  if (row.path === 'B' && row.cloudflareZoneId) {
    log.warn('domains.path_b_zone_kept', { zoneId: row.cloudflareZoneId, hostname: row.hostname });
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
    // The removed hostname is already off Coolify, so the site is not depending on this call.
    // Both a throw and a refusal are logged rather than swallowed: F-207 was a write that
    // *did* run with partial state, and the paired risk is one that quietly does not run.
    try {
      const redirects = await applyPrimaryRedirects(row.deploymentId);
      if (!redirects.ok) {
        log.warn('domains.primary_redirect_incomplete', {
          domainId,
          deploymentId: row.deploymentId,
          reason: redirects.reason,
        });
      }
    } catch (error) {
      log.warn('domains.primary_redirect_failed', {
        domainId,
        deploymentId: row.deploymentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { ok: true as const, data: { id: domainId } };
}

export async function emailProjectDomain(projectId: string, domainId: string, to: string) {
  const loaded = await loadProject(projectId, true);
  if (!loaded.ok) return { ok: false as const, error: loaded.error, status: loaded.status };
  const row = await findCustomDomainForProject(projectId, domainId);
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
