import { deleteRecord } from '@/lib/cloudflare/dns';
import { deleteApplication } from '@/lib/coolify/client';
import { archiveDeployRepo } from '@/lib/github/deploy-client';
import { prisma } from '@/lib/db';
import { serverAuth } from '@/lib/coolify/servers';
import { log, logError } from '@/lib/logger';
import type { JobResourceIds } from './types';

export type CompensateAdapters = {
  /** `false` means the app was left running (not configured / not issued). */
  deleteCoolifyApp: (uuid: string) => Promise<void | boolean>;
  deleteDnsRecord: (id: string) => Promise<void | boolean>;
  archiveDeployRepo: (name: string) => Promise<void | boolean>;
};

export function shouldCompensatePublish(hadSuccessfulDeployment: boolean) {
  return !hadSuccessfulDeployment;
}

function isAbsentError(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const status = 'status' in error ? Number((error as { status?: unknown }).status) : NaN;
  return status === 404;
}

async function tryDeleteCoolifyApp(uuid: string, serverId?: string | null): Promise<boolean> {
  if (!uuid) return false;
  try {
    if (serverId) {
      const server = await prisma.coolifyServer.findUnique({ where: { id: serverId } });
      if (server) {
        await deleteApplication(serverAuth(server), uuid);
        return true;
      }
    }
    const { getCoolifyClient } = await import('@/lib/coolify/client');
    const client = await getCoolifyClient();
    if (!client) return false;
    const result = await client.request(`/api/v1/applications/${uuid}`, { method: 'DELETE' });
    if (!result.ok && result.status !== 404) {
      throw new Error(`Coolify delete failed (${result.status})`);
    }
    return true;
  } catch (error) {
    if (isAbsentError(error)) return true;
    throw error;
  }
}

export async function deleteCoolifyApp(uuid: string, serverId?: string | null): Promise<void> {
  await tryDeleteCoolifyApp(uuid, serverId);
}

async function tryDeleteDnsRecord(id: string): Promise<boolean> {
  if (!id) return false;
  try {
    await deleteRecord(id);
    return true;
  } catch (error) {
    if (isAbsentError(error)) return true;
    throw error;
  }
}

export async function deleteDnsRecord(id: string): Promise<void> {
  await tryDeleteDnsRecord(id);
}

async function tryArchiveGithubRepo(name: string): Promise<boolean> {
  if (!name) return false;
  try {
    await archiveDeployRepo(name);
    return true;
  } catch (error) {
    if (isAbsentError(error)) return true;
    throw error;
  }
}

export async function archiveGithubRepo(name: string): Promise<void> {
  await tryArchiveGithubRepo(name);
}

export const defaultCompensateAdapters: CompensateAdapters = {
  deleteCoolifyApp: (uuid) => tryDeleteCoolifyApp(uuid),
  deleteDnsRecord: tryDeleteDnsRecord,
  archiveDeployRepo: tryArchiveGithubRepo,
};

/**
 * FIRST-TIME publish (no previous successful Deployment of that kind):
 * roll everything back. A half-created deployment serves nothing; slug/DNS
 * would block retry. Compensate every recorded resource, then clear them.
 *
 * RE-PUBLISH (a working deployment already exists): roll back NOTHING.
 * The existing site must keep serving. Never compensate resources that
 * predate this job — compare against the Deployment row's stored ids
 * before deleting anything.
 */
export async function compensateJobResources(input: {
  resources: JobResourceIds;
  hadSuccessfulDeployment: boolean;
  preexisting?: JobResourceIds;
  adapters?: CompensateAdapters;
}): Promise<{ rolledBack: boolean; compensated: Array<'coolify' | 'dns' | 'repo'> }> {
  if (!shouldCompensatePublish(input.hadSuccessfulDeployment)) {
    return { rolledBack: false, compensated: [] };
  }

  const adapters = input.adapters ?? defaultCompensateAdapters;
  const preexisting = input.preexisting ?? {};
  const compensated: Array<'coolify' | 'dns' | 'repo'> = [];

  const coolify = input.resources.coolifyAppUuid;
  if (coolify && coolify !== preexisting.coolifyAppUuid) {
    try {
      const deleted = await adapters.deleteCoolifyApp(coolify);
      if (deleted !== false) compensated.push('coolify');
    } catch (error) {
      if (!isAbsentError(error)) logError('jobs.compensate_coolify_failed', error);
    }
  }

  const dns = input.resources.dnsRecordId;
  if (dns && dns !== preexisting.dnsRecordId) {
    try {
      const deleted = await adapters.deleteDnsRecord(dns);
      if (deleted !== false) compensated.push('dns');
    } catch (error) {
      if (!isAbsentError(error)) logError('jobs.compensate_dns_failed', error);
    }
  }

  const repo = input.resources.githubRepo;
  if (repo && repo !== preexisting.githubRepo) {
    try {
      const archived = await adapters.archiveDeployRepo(repo);
      if (archived !== false) compensated.push('repo');
    } catch (error) {
      if (!isAbsentError(error)) logError('jobs.compensate_repo_failed', error);
    }
  }

  log.warn('jobs.compensate_publish', {
    rolledBack: true,
    compensated,
  });
  return { rolledBack: true, compensated };
}
