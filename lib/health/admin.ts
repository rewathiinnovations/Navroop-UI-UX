import { prisma } from '@/lib/db';
import { getProviderHealth } from '@/lib/ai/circuit';
import { loadOrphanReport } from '@/lib/jobs/orphans';
import { getEffectivePlan } from '@/lib/plans/limits';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { currentRelease, parseReleaseHistory } from '@/lib/deploy/release';
import { loadErrorTrackingPanel, loadSystemChecks } from '@/lib/observability/admin';
import { describeDataDir } from '@/lib/health/check';
import { getDataDirStatus } from '@/lib/runtime/data-dir';
import { getSelfIdentity } from '@/lib/runtime/self';

function since(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

async function windowCounts(from: Date) {
  const [generations, publishes] = await Promise.all([
    prisma.project.count({
      where: { generationStatus: 'error', updatedAt: { gte: from } },
    }),
    prisma.deployment.count({
      where: { status: 'FAILED', updatedAt: { gte: from } },
    }),
  ]);
  return { generations, publishes };
}

export async function getAdminHealth() {
  const [
    last24h,
    last7d,
    integrations,
    plan,
    deployErrors,
    integrationErrors,
    orphans,
    errorTracking,
    systemChecks,
  ] = await Promise.all([
    windowCounts(since(1)),
    windowCounts(since(7)),
    prisma.integration.findMany({
      where: { workspaceId: WORKSPACE_ROW_ID },
      select: { kind: true, status: true, lastCheckedAt: true, lastError: true },
    }),
    getEffectivePlan(WORKSPACE_ROW_ID),
    prisma.deployment.groupBy({
      by: ['lastError'],
      where: { status: 'FAILED', updatedAt: { gte: since(7) }, lastError: { not: null } },
      _count: { lastError: true },
      orderBy: { _count: { lastError: 'desc' } },
      take: 8,
    }),
    prisma.integration.findMany({
      where: { lastError: { not: null } },
      select: { kind: true, lastError: true },
    }),
    loadOrphanReport(),
    loadErrorTrackingPanel(),
    loadSystemChecks(),
  ]);

  const codes = new Map<string, number>();
  for (const row of deployErrors) {
    const code = (row.lastError || 'PUBLISH_FAILED').slice(0, 80);
    codes.set(code, (codes.get(code) ?? 0) + row._count.lastError);
  }
  for (const row of integrationErrors) {
    const code = `${row.kind}:${(row.lastError || 'INTEGRATION_ERROR').slice(0, 60)}`;
    codes.set(code, (codes.get(code) ?? 0) + 1);
  }

  const historyRow = await prisma.appSetting.findUnique({
    where: { key: 'deploy.history' },
    select: { value: true },
  });
  const release = currentRelease();

  return {
    release: {
      sha: release.sha,
      deployedAt: release.deployedAt,
      history: parseReleaseHistory(historyRow?.value),
    },
    // ADMIN-only. The Coolify UUID is an application identifier, not a
    // credential, and restart and rollback both fail without it — showing it
    // here beats discovering it is missing mid-rollback.
    self: getSelfIdentity(),
    integrations: integrations.map((row) => ({
      kind: row.kind,
      status: row.status,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      lastError: row.lastError,
    })),
    failures: { last24h, last7d },
    topErrorCodes: [...codes.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([code, count]) => ({ code, count })),
    orphans: orphans
      ? {
          checkedAt: orphans.checkedAt,
          coolify: orphans.counts.coolify,
          dns: orphans.counts.dns,
          repos: orphans.counts.repos,
          deleted: orphans.counts.deleted,
        }
      : { checkedAt: null, coolify: 0, dns: 0, repos: 0, deleted: 0 },
    providers: getProviderHealth(),
    errorTracking,
    systemChecks,
    dataDir: (() => {
      const status = describeDataDir(getDataDirStatus());
      const created = status.volumeCreatedAt ? Date.parse(status.volumeCreatedAt) : NaN;
      return {
        ...status,
        volumeAgeSeconds: Number.isFinite(created)
          ? Math.max(0, Math.floor((Date.now() - created) / 1000))
          : null,
      };
    })(),
  };
}
