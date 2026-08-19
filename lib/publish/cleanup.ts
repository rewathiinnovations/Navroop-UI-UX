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

export async function stopProjectDeployments(projectId: string) {
  const rows = await prisma.deployment.findMany({
    where: { projectId, status: { not: 'STOPPED' } },
  });
  for (const row of rows) {
    try {
      await removeDomainsForDeployment(row.id, DETACH_ONLY);
    } catch (error) {
      console.warn('[publish] custom domain detach failed', row.id, error);
    }
    if (row.coolifyAppUuid) {
      const ctx = await withServer(row.serverId);
      if (ctx) {
        try {
          await stopApplication(ctx.auth, row.coolifyAppUuid);
        } catch (error) {
          console.warn('[publish] stop failed', row.id, error);
        }
      }
    }
    await prisma.deployment.update({
      where: { id: row.id },
      data: { status: 'STOPPED' },
    });
  }
  return rows.length;
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
    console.warn('[publish] custom domain cleanup failed', row.id, error);
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
      console.warn('[publish] delete Coolify app failed', row.id, error);
      failures.push('coolify');
    }
  }
  if (row.dnsRecordId) {
    try {
      await deleteRecord(row.dnsRecordId);
    } catch (error) {
      console.warn('[publish] delete DNS failed', row.id, error);
      failures.push('dns');
    }
  }
  if (opts?.deleteRepo !== false && row.repoFullName) {
    try {
      await deleteDeployRepo(row.repoFullName, row.workspaceId || DEFAULT_WORKSPACE_ID);
    } catch (error) {
      console.warn('[publish] delete deploy repo failed', row.id, error);
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

export async function stopDeployment(id: string) {
  const row = await prisma.deployment.findUnique({ where: { id } });
  if (!row) throw new Error('Deployment not found');
  try {
    await removeDomainsForDeployment(row.id, DETACH_ONLY);
  } catch (error) {
    console.warn('[publish] custom domain detach failed', row.id, error);
  }
  if (row.coolifyAppUuid) {
    const ctx = await withServer(row.serverId);
    if (ctx) await stopApplication(ctx.auth, row.coolifyAppUuid);
  }
  return prisma.deployment.update({
    where: { id },
    data: { status: 'STOPPED' },
  });
}
