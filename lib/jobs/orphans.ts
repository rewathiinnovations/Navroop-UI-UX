import { prisma } from '@/lib/db';
import { log, logError } from '@/lib/logger';
import { DEFAULT_WORKSPACE_ID } from '@/lib/publish/constants';
import { isManagedCoolifyName, isManagedDnsName, isManagedRepoName } from '@/lib/publish/naming';
import { deleteCoolifyApp, deleteDnsRecord } from './compensate';

export const ORPHAN_DELETE_AFTER_MS = 24 * 60 * 60 * 1000;
export const ORPHAN_REPORT_KEY = 'orphans.lastReport';

export type OrphanKind = 'coolify' | 'dns' | 'repo';
export type OrphanAction = 'report' | 'delete';

export type OrphanItem = {
  kind: OrphanKind;
  action: OrphanAction;
  uuid?: string;
  id?: string;
  name: string;
  createdAt: string;
};

export type OrphanReport = {
  checkedAt: string;
  coolify: OrphanItem[];
  dns: OrphanItem[];
  repos: OrphanItem[];
  counts: { coolify: number; dns: number; repos: number; deleted: number };
};

export function classifyOrphan(input: {
  kind: OrphanKind;
  createdAt: Date;
  now?: Date;
}): { action: OrphanAction; reason: string } {
  if (input.kind === 'repo') {
    return { action: 'report', reason: 'Repos are never auto-deleted' };
  }
  const now = input.now ?? new Date();
  const age = now.getTime() - input.createdAt.getTime();
  if (age < ORPHAN_DELETE_AFTER_MS) {
    return { action: 'report', reason: 'Younger than 24 hours' };
  }
  return { action: 'delete', reason: 'Older than 24 hours and unmatched' };
}

export type OrphanInventory = {
  coolifyApps: Array<{ uuid: string; name: string; createdAt: Date }>;
  dnsRecords: Array<{ id: string; name: string; createdAt: Date }>;
  repos: Array<{ name: string; createdAt: Date }>;
};

export async function reconcileOrphans(input: {
  now?: Date;
  inventory: OrphanInventory;
  deployments: Array<{
    coolifyAppUuid?: string | null;
    dnsRecordId?: string | null;
    repoFullName?: string | null;
  }>;
  isManagedName: (name: string, kind: OrphanKind) => boolean;
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
  let deleted = 0;

  for (const app of input.inventory.coolifyApps) {
    if (knownApps.has(app.uuid)) continue;
    if (!input.isManagedName(app.name, 'coolify')) continue;
    const classified = classifyOrphan({ kind: 'coolify', createdAt: app.createdAt, now });
    if (classified.action === 'delete' && input.adapters?.deleteCoolifyApp) {
      await input.adapters.deleteCoolifyApp(app.uuid);
      deleted += 1;
    }
    coolify.push({
      kind: 'coolify',
      action: classified.action,
      uuid: app.uuid,
      name: app.name,
      createdAt: app.createdAt.toISOString(),
    });
  }

  for (const record of input.inventory.dnsRecords) {
    if (knownDns.has(record.id)) continue;
    if (!input.isManagedName(record.name, 'dns')) continue;
    const classified = classifyOrphan({ kind: 'dns', createdAt: record.createdAt, now });
    if (classified.action === 'delete' && input.adapters?.deleteDnsRecord) {
      await input.adapters.deleteDnsRecord(record.id);
      deleted += 1;
    }
    dns.push({
      kind: 'dns',
      action: classified.action,
      id: record.id,
      name: record.name,
      createdAt: record.createdAt.toISOString(),
    });
  }

  for (const repo of input.inventory.repos) {
    if (knownRepos.has(repo.name)) continue;
    if (!input.isManagedName(repo.name, 'repo')) continue;
    const classified = classifyOrphan({ kind: 'repo', createdAt: repo.createdAt, now });
    repos.push({
      kind: 'repo',
      action: 'report',
      name: repo.name,
      createdAt: repo.createdAt.toISOString(),
    });
    void classified;
  }

  return {
    checkedAt: now.toISOString(),
    coolify,
    dns,
    repos,
    counts: {
      coolify: coolify.length,
      dns: dns.length,
      repos: repos.length,
      deleted,
    },
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
    return JSON.parse(row.value) as OrphanReport;
  } catch {
    return null;
  }
}

export async function runOrphanCleanup(now = new Date()): Promise<OrphanReport> {
  const deployments = await prisma.deployment.findMany({
    select: { coolifyAppUuid: true, dnsRecordId: true, repoFullName: true },
  });

  const inventory: OrphanInventory = {
    coolifyApps: [],
    dnsRecords: [],
    repos: [],
  };

  try {
    const { listManagedApplications } = await import('@/lib/coolify/client');
    inventory.coolifyApps = await listManagedApplications();
  } catch (error) {
    logError('jobs.orphan_coolify_list_failed', error);
  }

  try {
    const { listManagedARecords } = await import('@/lib/cloudflare/dns');
    inventory.dnsRecords = await listManagedARecords();
  } catch (error) {
    logError('jobs.orphan_dns_list_failed', error);
  }

  try {
    const { listDeployRepos } = await import('@/lib/github/deploy-client');
    inventory.repos = await listDeployRepos(DEFAULT_WORKSPACE_ID);
  } catch (error) {
    logError('jobs.orphan_repo_list_failed', error);
  }

  const { getRootDomain } = await import('@/lib/integrations/store');
  const root = (await getRootDomain(DEFAULT_WORKSPACE_ID).catch(() => '')) || '';

  const report = await reconcileOrphans({
    now,
    inventory,
    deployments,
    isManagedName: (name, kind) => {
      if (kind === 'coolify') return isManagedCoolifyName(name);
      if (kind === 'dns') return isManagedDnsName(name, root);
      return isManagedRepoName(name);
    },
    adapters: {
      deleteCoolifyApp,
      deleteDnsRecord,
    },
  });

  await saveOrphanReport(report);
  log.warn('jobs.orphan_cleanup', report.counts);
  return report;
}
