import { prisma } from '@/lib/db';
import { log, logError } from '@/lib/logger';
import { DEFAULT_WORKSPACE_ID } from '@/lib/publish/constants';
import { parseResourceIds } from './types';
// Type-only: keeps the Coolify/Cloudflare/GitHub clients `cleanup.ts` imports out of this
// module's runtime graph, which the dynamic imports in `runOrphanCleanup` below also protect.
import type { PurgedPublishResource } from '@/lib/publish/cleanup';
import { deleteCoolifyApp, deleteDnsRecord } from './compensate';
import { getIntegration } from '@/lib/integrations/store';
import type { IntegrationKind } from '@/lib/integrations/types';

export const ORPHAN_DELETE_AFTER_MS = 24 * 60 * 60 * 1000;
export const ORPHAN_REPORT_KEY = 'orphans.lastReport';

/** How many skipped names the once-per-run info line carries. Enough to recognise the
 *  zone, short enough that a 100-record zone does not fill the log. */
const SKIPPED_LOG_SAMPLE = 10;

/** How many skipped names per kind survive into the persisted report and the cron response.
 *  `counts.skipped` stays the true total; the names are only there to be recognised. The
 *  whole report goes into one `AppSetting` row, so on a shared Coolify host or a populated
 *  zone the unbounded lists were every foreign app and record, every run. */
const SKIPPED_REPORT_LIMIT = 50;

export type OrphanKind = 'coolify' | 'dns' | 'repo';
export type OrphanAction = 'report' | 'delete';

export type OrphanItem = {
  kind: OrphanKind;
  action: OrphanAction;
  uuid?: string;
  id?: string;
  name: string;
  /** null when the provider listing carried no creation time — see `knownCreatedAt`. */
  createdAt: string | null;
};

export type OrphanReport = {
  checkedAt: string;
  coolify: OrphanItem[];
  dns: OrphanItem[];
  repos: OrphanItem[];
  /**
   * Enumerated resources this system has no record of creating: the operator's own
   * `www` A record, another product's app on a shared Coolify server. Never touched,
   * listed so an operator can see what the cron deliberately left alone.
   */
  skipped: { coolify: string[]; dns: string[]; repos: string[] };
  counts: { coolify: number; dns: number; repos: number; deleted: number; skipped: number };
  /**
   * Providers whose inventory could not be listed this run, as `<provider>: HTTP <status>`.
   *
   * Empty means every provider answered — "looked, found nothing". Non-empty means "could not
   * look", and the two used to be indistinguishable in every field above: a 401 from Cloudflare
   * left `inventory.dnsRecords` empty, so the run reported zero orphans, zero deletions and
   * `CronRun{ok: true}`, which an operator reads as "no orphans exist". The cron route fails
   * the run when this is non-empty.
   *
   * Provider and status only. This whole report is persisted in an `AppSetting` row and
   * returned in the cron response body, so no credential or error body may ride along.
   */
  listFailures: string[];
  /**
   * Providers this deploy holds no credential for, so no listing was attempted.
   *
   * Deliberately not a `listFailures` entry. A fresh install, a staging app, or any deploy that
   * never publishes has Cloudflare and GitHub disconnected for good, and failing the daily cron
   * for that would leave /admin/health permanently red for something that is not wrong — the
   * same alert fatigue `listFailures` exists to avoid, arriving from the other side. Nothing of
   * ours can be enumerated *or* deleted at a provider we cannot authenticate to, and
   * /admin/integrations already reports the state.
   */
  notConnected: string[];
};

/**
 * Identifiers this system recorded at the moment it created the resource: the
 * `Deployment` row's ids, every `resourceIds` entry the publish orchestrator persisted on a
 * PUBLISH job (`lib/publish/execute.ts`), which outlives a stop, and the ids
 * `purgeDeletedProjects` copies into its `project.hard_purge` audit entry, which is the only
 * one that outlives the `Job.project` cascade a hard purge triggers. See
 * `loadOrphanProvenance` for why all three are needed.
 *
 * This is the ONLY thing that makes a resource eligible for deletion. The cron used to
 * infer ownership from the name — any single-label A record in the zone matched
 * `/^((preview-)?[a-z0-9-]+)$/`, so `www`, `api` and `mail` were deleted 24h after the
 * cron first saw them, and any `live-*` app belonging to another product on a shared
 * Coolify server went with them. A name is a guess; a recorded id is proof.
 */
export type OrphanProvenance = {
  coolifyAppUuids: ReadonlySet<string>;
  dnsRecordIds: ReadonlySet<string>;
  repoFullNames: ReadonlySet<string>;
};

/**
 * Provider listings substitute the epoch when the upstream row carries no creation
 * time (`lib/cloudflare/dns.ts` used to, `lib/coolify/client.ts` and
 * `lib/github/deploy-client.ts` still do). Read literally that makes a resource created
 * seconds ago ~56 years old, i.e. instantly past every grace period. A missing timestamp
 * means "age unknown", which must mean "not eligible".
 */
function knownCreatedAt(value: Date | null | undefined): Date | null {
  if (!value) return null;
  const ms = value.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return value;
}

export function classifyOrphan(input: { kind: OrphanKind; createdAt: Date | null; now?: Date }): {
  action: OrphanAction;
  reason: string;
} {
  if (input.kind === 'repo') {
    return { action: 'report', reason: 'Repos are never auto-deleted' };
  }
  const createdAt = knownCreatedAt(input.createdAt);
  if (!createdAt) {
    return { action: 'report', reason: 'Creation time unknown' };
  }
  const now = input.now ?? new Date();
  const age = now.getTime() - createdAt.getTime();
  if (age < ORPHAN_DELETE_AFTER_MS) {
    return { action: 'report', reason: 'Younger than 24 hours' };
  }
  return { action: 'delete', reason: 'Older than 24 hours and unmatched' };
}

export type OrphanInventory = {
  coolifyApps: Array<{ uuid: string; name: string; createdAt: Date | null }>;
  dnsRecords: Array<{ id: string; name: string; createdAt: Date | null }>;
  repos: Array<{ name: string; createdAt: Date | null }>;
};

export async function reconcileOrphans(input: {
  now?: Date;
  inventory: OrphanInventory;
  deployments: Array<{
    coolifyAppUuid?: string | null;
    dnsRecordId?: string | null;
    repoFullName?: string | null;
  }>;
  provenance: OrphanProvenance;
  /**
   * Both carried through rather than derived: only the caller knows which listings answered, and
   * which it never attempted. An empty inventory arriving here is genuinely indistinguishable
   * from an unreachable provider, which is the whole reason these fields exist.
   */
  listFailures?: string[];
  notConnected?: string[];
  adapters?: {
    deleteCoolifyApp?: (uuid: string) => Promise<void>;
    deleteDnsRecord?: (id: string) => Promise<void>;
  };
}): Promise<OrphanReport> {
  const now = input.now ?? new Date();
  const knownApps = new Set(input.deployments.map((row) => row.coolifyAppUuid).filter(Boolean));
  const knownDns = new Set(input.deployments.map((row) => row.dnsRecordId).filter(Boolean));
  const knownRepos = new Set(input.deployments.map((row) => row.repoFullName).filter(Boolean));

  const coolify: OrphanItem[] = [];
  const dns: OrphanItem[] = [];
  const repos: OrphanItem[] = [];
  const skipped: OrphanReport['skipped'] = { coolify: [], dns: [], repos: [] };
  let deleted = 0;

  for (const app of input.inventory.coolifyApps) {
    if (knownApps.has(app.uuid)) continue;
    if (!input.provenance.coolifyAppUuids.has(app.uuid)) {
      skipped.coolify.push(app.name);
      continue;
    }
    const createdAt = knownCreatedAt(app.createdAt);
    const classified = classifyOrphan({ kind: 'coolify', createdAt, now });
    if (classified.action === 'delete' && input.adapters?.deleteCoolifyApp) {
      await input.adapters.deleteCoolifyApp(app.uuid);
      deleted += 1;
    }
    coolify.push({
      kind: 'coolify',
      action: classified.action,
      uuid: app.uuid,
      name: app.name,
      createdAt: createdAt?.toISOString() ?? null,
    });
  }

  for (const record of input.inventory.dnsRecords) {
    if (knownDns.has(record.id)) continue;
    if (!input.provenance.dnsRecordIds.has(record.id)) {
      skipped.dns.push(record.name);
      continue;
    }
    const createdAt = knownCreatedAt(record.createdAt);
    const classified = classifyOrphan({ kind: 'dns', createdAt, now });
    if (classified.action === 'delete' && input.adapters?.deleteDnsRecord) {
      await input.adapters.deleteDnsRecord(record.id);
      deleted += 1;
    }
    dns.push({
      kind: 'dns',
      action: classified.action,
      id: record.id,
      name: record.name,
      createdAt: createdAt?.toISOString() ?? null,
    });
  }

  for (const repo of input.inventory.repos) {
    if (knownRepos.has(repo.name)) continue;
    if (!input.provenance.repoFullNames.has(repo.name)) {
      skipped.repos.push(repo.name);
      continue;
    }
    const createdAt = knownCreatedAt(repo.createdAt);
    repos.push({
      kind: 'repo',
      action: classifyOrphan({ kind: 'repo', createdAt, now }).action,
      name: repo.name,
      createdAt: createdAt?.toISOString() ?? null,
    });
  }

  return {
    checkedAt: now.toISOString(),
    coolify,
    dns,
    repos,
    skipped,
    counts: {
      coolify: coolify.length,
      dns: dns.length,
      repos: repos.length,
      deleted,
      skipped: skipped.coolify.length + skipped.dns.length + skipped.repos.length,
    },
    listFailures: input.listFailures ?? [],
    notConnected: input.notConnected ?? [],
  };
}

export async function saveOrphanReport(report: OrphanReport) {
  await prisma.appSetting.upsert({
    where: { key: ORPHAN_REPORT_KEY },
    create: { key: ORPHAN_REPORT_KEY, value: JSON.stringify(report) },
    update: { value: JSON.stringify(report) },
  });
}

export async function loadOrphanReport(): Promise<OrphanReport | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: ORPHAN_REPORT_KEY } });
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value) as OrphanReport;
    // Reports written before listing failures were tracked carry no field. An older row means
    // "not recorded", and /admin/health reads this — the honest rendering of an unknown is an
    // empty list, not a crash on `undefined.length`.
    return {
      ...parsed,
      listFailures: Array.isArray(parsed.listFailures) ? parsed.listFailures : [],
      notConnected: Array.isArray(parsed.notConnected) ? parsed.notConnected : [],
    };
  } catch {
    return null;
  }
}

/**
 * The three ids the orphan cron can act on, in the shape `purgeDeletedProjects` persists.
 * `Pick` rather than a fresh literal so renaming a field on the producer breaks this parse
 * instead of silently reading `undefined` out of every historical audit row.
 */
type PurgedResourceIds = Pick<
  PurgedPublishResource,
  'coolifyAppUuid' | 'dnsRecordId' | 'repoFullName'
>;

/**
 * The `project.hard_purge` audit `after` payload, read back as deletion provenance.
 *
 * Narrowed field by field rather than schema-validated because it is read across a year of
 * historical rows (`pruneAuditLogs` is the retention bound): an entry written by an older
 * build contributes no ids instead of failing the run.
 */
function parsePurgedResourceIds(after: unknown): PurgedResourceIds[] {
  if (!after || typeof after !== 'object' || !('deployments' in after)) return [];
  const listed = after.deployments;
  if (!Array.isArray(listed)) return [];
  const entries: unknown[] = listed;
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    return [
      {
        coolifyAppUuid:
          'coolifyAppUuid' in entry && typeof entry.coolifyAppUuid === 'string'
            ? entry.coolifyAppUuid
            : null,
        dnsRecordId:
          'dnsRecordId' in entry && typeof entry.dnsRecordId === 'string'
            ? entry.dnsRecordId
            : null,
        repoFullName:
          'repoFullName' in entry && typeof entry.repoFullName === 'string'
            ? entry.repoFullName
            : null,
      },
    ];
  });
}

/**
 * Every resource id this system is on record as having created, from three sources.
 *
 * A `Deployment` row is the live pointer, and `destroyDeployment` now refuses to delete it
 * while a provider still holds the resource, so a failed teardown leaves the pointer intact
 * for the next pass. A PUBLISH job's `resourceIds` is the creation receipt and survives the
 * row being stopped.
 *
 * Neither survives a hard purge: `Job.project` is `onDelete: Cascade`
 * (`prisma/schema.prisma`), so deleting the Project takes every PUBLISH receipt with it. The
 * `project.hard_purge` audit entry is the third source and the only one that outlives that
 * cascade — `purgeDeletedProjects` writes the ids into it before the delete. Without it, a
 * resource the provider reported gone but kept alive was classified `skipped` on every
 * subsequent run, forever, because name-shape deletion is not coming back.
 */
async function loadOrphanProvenance(
  deployments: Array<{
    coolifyAppUuid: string | null;
    dnsRecordId: string | null;
    repoFullName: string | null;
  }>,
): Promise<OrphanProvenance> {
  const coolifyAppUuids = new Set<string>();
  const dnsRecordIds = new Set<string>();
  const repoFullNames = new Set<string>();

  for (const row of deployments) {
    if (row.coolifyAppUuid) coolifyAppUuids.add(row.coolifyAppUuid);
    if (row.dnsRecordId) dnsRecordIds.add(row.dnsRecordId);
    if (row.repoFullName) repoFullNames.add(row.repoFullName);
  }

  const publishJobs = await prisma.job.findMany({
    where: { kind: 'PUBLISH' },
    select: { resourceIds: true },
  });
  for (const job of publishJobs) {
    const ids = parseResourceIds(job.resourceIds);
    if (!ids) continue;
    if (ids.coolifyAppUuid) coolifyAppUuids.add(ids.coolifyAppUuid);
    if (ids.dnsRecordId) dnsRecordIds.add(ids.dnsRecordId);
    if (ids.githubRepo) repoFullNames.add(ids.githubRepo);
  }

  const purges = await prisma.auditLog.findMany({
    where: { action: 'project.hard_purge' },
    select: { after: true },
  });
  for (const entry of purges) {
    for (const resource of parsePurgedResourceIds(entry.after)) {
      if (resource.coolifyAppUuid) coolifyAppUuids.add(resource.coolifyAppUuid);
      if (resource.dnsRecordId) dnsRecordIds.add(resource.dnsRecordId);
      if (resource.repoFullName) repoFullNames.add(resource.repoFullName);
    }
  }

  return { coolifyAppUuids, dnsRecordIds, repoFullNames };
}

/**
 * `<provider>: HTTP <status>` from a listing error, or the provider name alone when the call
 * never reached an HTTP response (DNS failure, refused connection, timeout).
 *
 * The status comes off `CoolifyApiError`/`CloudflareDnsError`/`GithubAppError`, all of which
 * carry a numeric `status`. The error *message* is deliberately not used: this string is
 * persisted in an `AppSetting` row and returned in the cron response body, and a provider
 * message can quote the request that carried the credential. The message still goes to
 * `logError` below, where it always went.
 */
function listFailureDetail(provider: string, error: unknown) {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status > 0
    ? `${provider}: HTTP ${status}`
    : `${provider}: unreachable`;
}

/**
 * Whether this deploy holds a usable credential for a provider.
 *
 * Asked before each listing rather than inferred from the error the client throws: the clients
 * signal "not connected" with an ordinary `Error` message, and matching on message text in the
 * one place whose job is to report honestly is how the next rename turns a fresh install red.
 */
async function isProviderConnected(kind: IntegrationKind) {
  const row = await getIntegration(DEFAULT_WORKSPACE_ID, kind);
  return row?.status === 'CONNECTED';
}

export async function runOrphanCleanup(now = new Date()): Promise<OrphanReport> {
  const deployments = await prisma.deployment.findMany({
    select: { coolifyAppUuid: true, dnsRecordId: true, repoFullName: true },
  });
  const provenance = await loadOrphanProvenance(deployments);

  const inventory: OrphanInventory = {
    coolifyApps: [],
    dnsRecords: [],
    repos: [],
  };
  // An empty inventory kind below means one of two opposite things — nothing there, or nothing
  // visible — and only this block can tell them apart. Three outcomes, not two: listed,
  // could-not-list (`listFailures`, fails the run), and never-attempted because the integration
  // is not connected (`notConnected`, does not).
  const listFailures: string[] = [];
  const notConnected: string[] = [];

  // The three provider clients load dynamically on purpose: `loadOrphanReport` above is
  // read by the admin health dashboard, and a static import would pull the Coolify,
  // Cloudflare and GitHub App clients into that request's module graph.
  //
  // Each is gated on the integration being CONNECTED first. Without the gate, the clients throw
  // "…is not connected" on a deploy that never publishes, and this cron would be red forever on
  // every fresh install and every staging app.
  if (await isProviderConnected('COOLIFY')) {
    try {
      const { listManagedApplications } = await import('@/lib/coolify/client');
      const listed = await listManagedApplications();
      inventory.coolifyApps = listed.apps;
      // A configured server that did not answer is a failure, not a skip: the credential exists
      // and the box did not reply, so whatever is running on it is invisible to this run. The
      // client used to swallow this per server and return the apps it did get.
      for (const server of listed.unreachable) listFailures.push(`coolify server ${server}`);
    } catch (error) {
      logError('jobs.orphan_coolify_list_failed', error);
      listFailures.push(listFailureDetail('coolify', error));
    }
  } else {
    notConnected.push('coolify');
  }

  if (await isProviderConnected('CLOUDFLARE')) {
    try {
      const { listZoneARecords } = await import('@/lib/cloudflare/dns');
      inventory.dnsRecords = await listZoneARecords();
    } catch (error) {
      logError('jobs.orphan_dns_list_failed', error);
      listFailures.push(listFailureDetail('cloudflare-dns', error));
    }
  } else {
    notConnected.push('cloudflare-dns');
  }

  if (await isProviderConnected('GITHUB_DEPLOY')) {
    try {
      const { listDeployRepos } = await import('@/lib/github/deploy-client');
      inventory.repos = await listDeployRepos(DEFAULT_WORKSPACE_ID);
    } catch (error) {
      logError('jobs.orphan_repo_list_failed', error);
      listFailures.push(listFailureDetail('github-repos', error));
    }
  } else {
    notConnected.push('github-repos');
  }

  const report = await reconcileOrphans({
    listFailures,
    notConnected,
    now,
    inventory,
    deployments,
    provenance,
    adapters: {
      deleteCoolifyApp,
      deleteDnsRecord,
    },
  });

  log.warn('jobs.orphan_cleanup', report.counts);
  if (report.counts.skipped > 0) {
    // Once per run, with a bounded sample. These are the records and apps the cron used
    // to delete on a name match; an operator should be able to see that they were seen
    // and left alone, without the line growing with the size of the zone. Logged before the
    // bound below, so these numbers are the real ones.
    log.info('jobs.orphan_skipped_unowned', {
      coolify: report.skipped.coolify.length,
      dns: report.skipped.dns.length,
      repos: report.skipped.repos.length,
      sample: [...report.skipped.coolify, ...report.skipped.dns, ...report.skipped.repos].slice(
        0,
        SKIPPED_LOG_SAMPLE,
      ),
    });
  }

  const bounded: OrphanReport = {
    ...report,
    skipped: {
      coolify: report.skipped.coolify.slice(0, SKIPPED_REPORT_LIMIT),
      dns: report.skipped.dns.slice(0, SKIPPED_REPORT_LIMIT),
      repos: report.skipped.repos.slice(0, SKIPPED_REPORT_LIMIT),
    },
  };
  await saveOrphanReport(bounded);
  return bounded;
}
