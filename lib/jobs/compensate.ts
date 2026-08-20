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

/** Which provider a teardown addressed, in the order they are attempted. */
export type CompensatedResource = 'coolify' | 'dns' | 'repo';

/**
 * What a rollback did, not what it intended.
 *
 * - `kept_live`: a re-publish, so nothing was torn down on purpose.
 * - `rolled_back`: every resource this job created is gone (or was already absent).
 * - `partial`: at least one is still up. The marker is deliberately distinct so the
 *   caller can retry and so the recovery panel does not print "cleaned up" over a
 *   container that is still running and still billing.
 */
export type CompensateOutcome = 'kept_live' | 'rolled_back' | 'partial';

export type CompensateResult = {
  outcome: CompensateOutcome;
  /** Torn down, so their ids may be cleared from the job and the Deployment row. */
  compensated: CompensatedResource[];
  /** Still up. Their ids MUST stay recorded — the orphan cron only deletes what it can trace. */
  failed: CompensatedResource[];
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
 *
 * Every delete is best-effort — one provider being down must not abandon the other two —
 * but a swallowed failure is not a success. `outcome` used to be hardcoded `true` here, so
 * a rollback in which every single delete 5xx'd still reported `rolled_back`, the recovery
 * panel said "Incomplete work was cleaned up", and the marker it wrote made the whole
 * compensation single-shot (F-046).
 */
export async function compensateJobResources(input: {
  resources: JobResourceIds;
  hadSuccessfulDeployment: boolean;
  preexisting?: JobResourceIds;
  adapters?: CompensateAdapters;
}): Promise<CompensateResult> {
  if (!shouldCompensatePublish(input.hadSuccessfulDeployment)) {
    return { outcome: 'kept_live', compensated: [], failed: [] };
  }

  const adapters = input.adapters ?? defaultCompensateAdapters;
  const preexisting = input.preexisting ?? {};
  const compensated: CompensatedResource[] = [];
  const failed: CompensatedResource[] = [];

  const attempt = async (
    resource: CompensatedResource,
    event: string,
    run: () => Promise<void | boolean>,
  ) => {
    try {
      // `false` means the adapter declined — not configured, no client — so the resource
      // is still up. Same user-visible state as a refused delete, same bucket.
      const removed = await run();
      if (removed === false) {
        log.warn(event, { resource, reason: 'adapter declined' });
        failed.push(resource);
        return;
      }
      compensated.push(resource);
    } catch (error) {
      // A 404 is the state we were trying to reach.
      if (isAbsentError(error)) {
        compensated.push(resource);
        return;
      }
      logError(event, error);
      failed.push(resource);
    }
  };

  const coolify = input.resources.coolifyAppUuid;
  if (coolify && coolify !== preexisting.coolifyAppUuid) {
    await attempt('coolify', 'jobs.compensate_coolify_failed', () =>
      adapters.deleteCoolifyApp(coolify),
    );
  }

  const dns = input.resources.dnsRecordId;
  if (dns && dns !== preexisting.dnsRecordId) {
    await attempt('dns', 'jobs.compensate_dns_failed', () => adapters.deleteDnsRecord(dns));
  }

  const repo = input.resources.githubRepo;
  if (repo && repo !== preexisting.githubRepo) {
    await attempt('repo', 'jobs.compensate_repo_failed', () => adapters.archiveDeployRepo(repo));
  }

  const outcome: CompensateOutcome = failed.length === 0 ? 'rolled_back' : 'partial';
  log.warn('jobs.compensate_publish', { outcome, compensated, failed });
  return { outcome, compensated, failed };
}
