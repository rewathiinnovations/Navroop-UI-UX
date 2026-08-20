import type { Deployment, DeploymentKind } from '@/generated/prisma';
import { prisma } from '@/lib/db';
import { deleteApplication, stopApplication } from '@/lib/coolify/client';
import { serverAuth } from '@/lib/coolify/servers';
import { deleteRecord } from '@/lib/cloudflare/dns';
import { deleteDeployRepo } from '@/lib/github/deploy-client';
import { removeDomainsForDeployment } from '@/lib/domains/cleanup';
import { listCustomDomainsForDeployment } from '@/lib/domains/store';
import { log } from '@/lib/logger';
import { DEFAULT_WORKSPACE_ID } from './constants';

async function withServer(serverId: string) {
  const server = await prisma.coolifyServer.findUnique({ where: { id: serverId } });
  if (!server) return null;
  return { server, auth: serverAuth(server) };
}

/**
 * Stop and soft-delete are reversible — the Deployment row survives as STOPPED and the
 * project can be restored — so they detach with `deleteRows: false`: the hostname leaves the
 * Coolify application while every CustomDomain row keeps its verifyToken, expectedTarget,
 * isPrimary and (Path B) cloudflareZoneId, and the next publish re-attaches it in the
 * `domain` step. Sharing the destructive cleanup with destroy/purge meant one Stop cost the
 * user a full 7-day re-verification and left the Path B zone on the Cloudflare account with
 * nothing in the product pointing at it.
 */
const DETACH_ONLY = { deleteRows: false } as const;

/**
 * The zone itself is deliberately never deleted — it holds the customer's DNS. Once the
 * CustomDomain row goes, the zone id survives only in what this returns, so the caller must
 * put it somewhere durable: the delete action writes it into its `deployment.delete` audit
 * entry, and the retention purge writes it into `project.hard_purge` (it used to discard the
 * return value entirely, so the automated path — the one with nobody watching — left the
 * zone id in a log line that ages out).
 */
async function pathBZonesFor(deploymentId: string) {
  const rows = await listCustomDomainsForDeployment(deploymentId);
  return rows.flatMap((row) =>
    row.path === 'B' && row.cloudflareZoneId
      ? [{ hostname: row.hostname, zoneId: row.cloudflareZoneId }]
      : [],
  );
}

/**
 * One deployment stopped, or the reason it was not.
 *
 * `stopped: false` means nothing was mutated at all: the row still carries its previous
 * status and every hostname is still attached to the Coolify application, so a retry is
 * the same operation rather than the second half of a half-finished one.
 */
export type StopOutcome =
  { stopped: true; deployment: Deployment } | { stopped: false; reason: string };

/**
 * The one implementation of "stop this deployment", shared by the `/deployments` Stop
 * button and project soft-delete.
 *
 * The two used to disagree about whether a Coolify failure is fatal: `stopDeployment`
 * detached the domains and then let the `stopApplication` error propagate out of the
 * server action, so the hostnames were off the application while the row still said LIVE
 * and the site was still running; `stopProjectDeployments` swallowed the same error and
 * wrote STOPPED over a container that was still up (F-223). Both are wrong in the same
 * way — a status is a claim about the provider, so it may only be written once the
 * provider agreed.
 *
 * Hence the order: ask Coolify first and return the refusal untouched; only a successful
 * stop earns the domain detach and the STOPPED row. The detach itself stays best-effort
 * (`log.warn`) because a stopped application serves nothing — a hostname left attached to
 * it costs the user nothing and the next publish re-attaches it.
 */
async function stopOneDeployment(row: Deployment): Promise<StopOutcome> {
  if (row.coolifyAppUuid) {
    const ctx = await withServer(row.serverId);
    if (ctx) {
      try {
        await stopApplication(ctx.auth, row.coolifyAppUuid);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log.warn('publish.stop_failed', { deploymentId: row.id, reason });
        return { stopped: false, reason };
      }
    } else {
      // The CoolifyServer row is gone, so there is nothing left to ask. Recorded rather
      // than silent: the application may well still be running on a server this system
      // no longer knows how to reach.
      log.warn('publish.stop_server_missing', { deploymentId: row.id, serverId: row.serverId });
    }
  }
  try {
    await removeDomainsForDeployment(row.id, DETACH_ONLY);
  } catch (error) {
    log.warn('publish.stop_domain_detach_failed', {
      deploymentId: row.id,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  const deployment = await prisma.deployment.update({
    where: { id: row.id },
    data: { status: 'STOPPED' },
  });
  return { stopped: true, deployment };
}

export type StopProjectDeploymentsResult = {
  /** How many rows now say STOPPED because Coolify agreed to stop them. */
  stopped: number;
  /** The deployments still running, so the caller can report them instead of assuming. */
  failed: Array<{ deploymentId: string; reason: string }>;
};

export async function stopProjectDeployments(
  projectId: string,
): Promise<StopProjectDeploymentsResult> {
  const rows = await prisma.deployment.findMany({
    where: { projectId, status: { not: 'STOPPED' } },
  });
  let stopped = 0;
  const failed: StopProjectDeploymentsResult['failed'] = [];
  for (const row of rows) {
    // One refusal must not abandon the rest — a soft-deleted project's other deployment
    // is still costing money.
    const outcome = await stopOneDeployment(row);
    if (outcome.stopped) stopped += 1;
    else failed.push({ deploymentId: row.id, reason: outcome.reason });
  }
  return { stopped, failed };
}

/**
 * The sentence for a soft-delete whose sites did not all come down.
 *
 * The project is gone from the dashboard whatever Coolify answered — `deletedAt` is already
 * stamped and the retention purge is the retry — so this rides on a success rather than
 * turning the delete into a failure. Saying nothing was the bug: the applications kept
 * serving the deleted site and kept billing, and the only record was a `console.warn`
 * (F-806).
 */
export function stoppedPartiallyMessage(failed: StopProjectDeploymentsResult['failed']) {
  const count = failed.length;
  const subject = count === 1 ? 'deployment is' : 'deployments are';
  return `The project was deleted, but ${count} ${subject} still running — Coolify refused to stop ${count === 1 ? 'it' : 'them'}. ${count === 1 ? 'It keeps' : 'They keep'} costing money until the teardown succeeds; it is retried automatically.`;
}

/**
 * A resource this system created, in the shape that has to outlive the rows naming it.
 * `purgeDeletedProjects` writes these into the `project.hard_purge` audit entry and
 * `lib/jobs/orphans.ts` reads them back as deletion provenance.
 */
export type PurgedPublishResource = {
  deploymentId: string;
  slug: string;
  kind: DeploymentKind;
  coolifyAppUuid: string | null;
  dnsRecordId: string | null;
  repoFullName: string | null;
};

export type DestroyedDeployment = {
  deployment: Deployment;
  keptCloudflareZones: Array<{ hostname: string; zoneId: string }>;
  /** Which provider deletes did not succeed, e.g. `['coolify']`. Empty means fully torn down. */
  failures: string[];
  /** False when `failures` is non-empty: the row is the surviving receipt, see below. */
  rowDeleted: boolean;
};

/** What each `failures` entry means to someone reading a toast. */
const PROVIDER_LABELS: Record<string, string> = {
  coolify: 'the Coolify application',
  dns: 'the DNS record',
  repo: 'the deploy repository',
};

/**
 * The sentence for a teardown that only partly worked.
 *
 * `destroyDeployment` keeps the row in this case, so the user's next page load will show
 * the deployment again. The copy has to agree with that: naming what survived is the
 * difference between "retry this" and "the product is lying to me".
 */
export function partialTeardownMessage(failures: string[]) {
  const named = failures.map((failure) => PROVIDER_LABELS[failure] ?? failure).join(', ');
  return `Could not remove ${named}. This deployment is still listed so the teardown can be retried — until it is gone it keeps running and keeps costing money.`;
}

export async function destroyDeployment(
  id: string,
  opts?: { deleteRepo?: boolean },
): Promise<DestroyedDeployment | null> {
  const row = await prisma.deployment.findUnique({ where: { id } });
  if (!row) return null;

  // Only a hard delete may destroy CustomDomain rows. Best-effort like every other external
  // call below: this read used to be the one unguarded statement in the function, so a single
  // Prisma hiccup aborted the whole teardown before anything was cleaned up (and, from the
  // purge path, aborted it *and* still destroyed the receipts). Losing the zone report must
  // not stop the teardown — but it must not vanish silently either, hence the warn.
  let keptCloudflareZones: DestroyedDeployment['keptCloudflareZones'] = [];
  try {
    keptCloudflareZones = await pathBZonesFor(row.id);
  } catch (error) {
    log.warn('publish.path_b_zone_lookup_failed', {
      deploymentId: row.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    await removeDomainsForDeployment(row.id);
  } catch (error) {
    log.warn('publish.custom_domain_cleanup_failed', {
      deploymentId: row.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (keptCloudflareZones.length > 0) {
    log.warn('publish.path_b_zones_kept', { deploymentId: row.id, zones: keptCloudflareZones });
  }

  const failures: string[] = [];
  const ctx = row.coolifyAppUuid ? await withServer(row.serverId) : null;
  if (ctx && row.coolifyAppUuid) {
    try {
      await deleteApplication(ctx.auth, row.coolifyAppUuid);
    } catch (error) {
      log.warn('publish.coolify_delete_failed', {
        deploymentId: row.id,
        coolifyAppUuid: row.coolifyAppUuid,
        error: error instanceof Error ? error.message : String(error),
      });
      failures.push('coolify');
    }
  }
  if (row.dnsRecordId) {
    try {
      await deleteRecord(row.dnsRecordId);
    } catch (error) {
      log.warn('publish.dns_delete_failed', {
        deploymentId: row.id,
        dnsRecordId: row.dnsRecordId,
        error: error instanceof Error ? error.message : String(error),
      });
      failures.push('dns');
    }
  }
  if (opts?.deleteRepo !== false && row.repoFullName) {
    try {
      await deleteDeployRepo(row.repoFullName, row.workspaceId || DEFAULT_WORKSPACE_ID);
    } catch (error) {
      log.warn('publish.repo_delete_failed', {
        deploymentId: row.id,
        repoFullName: row.repoFullName,
        error: error instanceof Error ? error.message : String(error),
      });
      failures.push('repo');
    }
  }

  if (failures.length > 0) {
    // The row is the last thing naming these ids, and the orphan cron will only delete a
    // resource whose id this system recorded creating (`lib/jobs/orphans.ts`). Deleting the
    // row after a failed provider delete produced a container that kept running and billing
    // with its uuid recorded nowhere — permanently unreapable, because name-shape deletion is
    // not coming back. Keeping the row means the next purge pass retries the same teardown.
    log.warn('publish.destroy_incomplete_row_kept', { deploymentId: row.id, failures });
    return { deployment: row, keptCloudflareZones, failures, rowDeleted: false };
  }

  await prisma.deployment.delete({ where: { id: row.id } });
  return { deployment: row, keptCloudflareZones, failures, rowDeleted: true };
}

export type PurgedProjectPublishResources = {
  deployments: number;
  resources: PurgedPublishResource[];
  keptCloudflareZones: Array<{ hostname: string; zoneId: string }>;
  /** `<deploymentId>:<provider>` for every provider delete that did not succeed. */
  failures: string[];
};

/**
 * Tears down every deployment of a project and hands the caller everything that has to
 * outlive the `Project` row. `Job.project` is `onDelete: Cascade`, so deleting the project
 * takes every PUBLISH job's `resourceIds` — the creation receipts — with it; the caller must
 * therefore refuse to delete while `failures` is non-empty, and must persist `resources`
 * before it does delete.
 */
export async function purgeProjectPublishResources(
  projectId: string,
): Promise<PurgedProjectPublishResources> {
  const rows = await prisma.deployment.findMany({ where: { projectId } });
  const resources: PurgedPublishResource[] = [];
  const keptCloudflareZones: Array<{ hostname: string; zoneId: string }> = [];
  const failures: string[] = [];
  for (const row of rows) {
    const destroyed = await destroyDeployment(row.id, { deleteRepo: true });
    if (!destroyed) continue;
    resources.push({
      deploymentId: row.id,
      slug: row.slug,
      kind: row.kind,
      coolifyAppUuid: row.coolifyAppUuid,
      dnsRecordId: row.dnsRecordId,
      repoFullName: row.repoFullName,
    });
    keptCloudflareZones.push(...destroyed.keptCloudflareZones);
    for (const failure of destroyed.failures) failures.push(`${row.id}:${failure}`);
  }
  return { deployments: rows.length, resources, keptCloudflareZones, failures };
}

export async function stopDeployment(id: string): Promise<StopOutcome> {
  const row = await prisma.deployment.findUnique({ where: { id } });
  if (!row) throw new Error('Deployment not found');
  return stopOneDeployment(row);
}
