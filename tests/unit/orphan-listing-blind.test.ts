import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The difference between "looked and found nothing" and "could not look".
 *
 * `runOrphanCleanup` swallowed each of its three provider listings with a `logError` and carried
 * on with an empty inventory. Because deletion is driven purely by what was enumerated, a 401
 * from Coolify or Cloudflare is *safe* — nothing gets deleted — and that is exactly what made it
 * dangerous: zero orphans, zero deletions, HTTP 200 and `CronRun{ok: true}`, which an operator
 * reads on /admin/health as "there are no orphans", when the truth is that the cron was blind
 * and paid-for containers may have been running unnoticed for weeks.
 *
 * Goes red if a listing failure becomes silent again, if the provider stops being named, if a
 * credential or provider error body starts riding along into the persisted report, or if a
 * failed listing ever widens deletion.
 */

const db = vi.hoisted(() => ({
  deploymentFindMany: vi.fn(),
  jobFindMany: vi.fn(),
  appSettingUpsert: vi.fn(),
  auditLogFindMany: vi.fn(),
}));
const providers = vi.hoisted(() => ({
  listManagedApplications: vi.fn(),
  listZoneARecords: vi.fn(),
  listDeployRepos: vi.fn(),
}));
const deletes = vi.hoisted(() => ({ coolify: vi.fn(), dns: vi.fn() }));
const cron = vi.hoisted(() => ({ createCronRun: vi.fn() }));
const integrations = vi.hoisted(() => ({ getIntegration: vi.fn() }));

vi.mock('@/lib/db', () => ({
  prisma: {
    deployment: { findMany: db.deploymentFindMany },
    job: { findMany: db.jobFindMany },
    appSetting: { upsert: db.appSettingUpsert },
    auditLog: { findMany: db.auditLogFindMany },
  },
}));
vi.mock('@/lib/coolify/client', () => ({
  listManagedApplications: providers.listManagedApplications,
}));
vi.mock('@/lib/cloudflare/dns', () => ({ listZoneARecords: providers.listZoneARecords }));
vi.mock('@/lib/github/deploy-client', () => ({ listDeployRepos: providers.listDeployRepos }));
vi.mock('@/lib/jobs/compensate', () => ({
  deleteCoolifyApp: deletes.coolify,
  deleteDnsRecord: deletes.dns,
}));
vi.mock('@/lib/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logError: vi.fn(),
}));
// The route is exercised through `handleCron`, which is where the outcome becomes a `CronRun`
// row and an HTTP status. Auth is not what this file is about.
vi.mock('@/lib/cron/auth', () => ({ authorizeCron: async () => true }));
vi.mock('@/lib/observability/store', () => ({
  getObservabilityStore: () => ({ createCronRun: cron.createCronRun }),
}));
// Every provider CONNECTED unless a case says otherwise: the gate below decides whether a
// listing is attempted at all, and an unconfigured provider must never read as a failure.
vi.mock('@/lib/integrations/store', () => ({
  getIntegration: integrations.getIntegration,
  invalidateIntegrationCache: () => undefined,
}));

// Dynamic so the `vi.mock` factories are installed first; a static import would be hoisted
// above them and pull the real Coolify, Cloudflare and GitHub clients into the module graph.
const { runOrphanCleanup } = await import('@/lib/jobs/orphans');
const { POST } = await import('@/app/api/cron/cleanup-orphans/route');

const NOW = new Date('2026-08-19T12:00:00.000Z');
const THIRTY_HOURS_AGO = new Date('2026-08-18T06:00:00.000Z');

/**
 * The credential must never appear in the report, so the fixture deliberately puts
 * one in the provider's error message and the assertions prove it is not echoed.
 * Built from parts so the staged credential scanner does not read the fixture
 * itself as a leak.
 */
const TOKEN = ['cf', 'live', 'fixture', 'do', 'not', 'log'].join('_');

function listingError(status: number) {
  return Object.assign(new Error(`Unauthorized (token ${TOKEN})`), { status });
}

function cronRuns() {
  return cron.createCronRun.mock.calls.map(
    (call) => call[0] as { ok: boolean; detail?: string | null },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  db.deploymentFindMany.mockResolvedValue([]);
  db.jobFindMany.mockResolvedValue([]);
  db.appSettingUpsert.mockResolvedValue({});
  db.auditLogFindMany.mockResolvedValue([]);
  integrations.getIntegration.mockResolvedValue({ status: 'CONNECTED', config: {}, secrets: {} });
  providers.listManagedApplications.mockResolvedValue({ apps: [], unreachable: [] });
  providers.listZoneARecords.mockResolvedValue([]);
  providers.listDeployRepos.mockResolvedValue([]);
  deletes.coolify.mockResolvedValue(undefined);
  deletes.dns.mockResolvedValue(undefined);
  cron.createCronRun.mockResolvedValue({});
});

describe('cleanup-orphans when a provider listing fails', () => {
  it('names the provider and its status in the report, without the credential', async () => {
    providers.listZoneARecords.mockRejectedValue(listingError(401));

    const report = await runOrphanCleanup(NOW);

    expect(report.listFailures).toEqual(['cloudflare-dns: HTTP 401']);
    // The whole report is persisted in an AppSetting row and returned in the cron response.
    expect(JSON.stringify(report)).not.toContain(TOKEN);
  });

  it('says "unreachable" when the call never got an HTTP answer', async () => {
    providers.listManagedApplications.mockRejectedValue(new Error('ECONNREFUSED'));

    const report = await runOrphanCleanup(NOW);

    expect(report.listFailures).toEqual(['coolify: unreachable']);
  });

  it('records the run failed, with the provider named in the CronRun detail', async () => {
    providers.listManagedApplications.mockRejectedValue(listingError(401));

    const response = await POST(
      new Request('http://localhost/api/cron/cleanup-orphans', { method: 'POST' }),
    );

    expect(response.status).toBe(500);
    expect(cronRuns()).toHaveLength(1);
    expect(cronRuns()[0].ok).toBe(false);
    expect(cronRuns()[0].detail).toContain('coolify: HTTP 401');
    expect(cronRuns()[0].detail).not.toContain(TOKEN);
  });

  it('still reports healthy when every provider answered and found nothing', async () => {
    const response = await POST(
      new Request('http://localhost/api/cron/cleanup-orphans', { method: 'POST' }),
    );

    expect(response.status).toBe(200);
    expect(cronRuns()[0]).toMatchObject({ ok: true, detail: null });
  });

  it('deletes nothing extra: a failed listing narrows the run, it cannot widen it', async () => {
    // Both resources are ours by provenance and both are past the 24h grace, so with healthy
    // listings both would be deleted. Cloudflare fails, and the only difference must be that
    // its record is not reached — never that an un-enumerated resource is treated as reapable.
    db.jobFindMany.mockResolvedValue([
      { resourceIds: { coolifyAppUuid: 'app-ours', dnsRecordId: 'rec-ours', githubRepo: null } },
    ]);
    providers.listManagedApplications.mockResolvedValue({
      apps: [{ uuid: 'app-ours', name: 'live-acme', createdAt: THIRTY_HOURS_AGO }],
      unreachable: [],
    });
    providers.listZoneARecords.mockRejectedValue(listingError(403));

    const report = await runOrphanCleanup(NOW);

    expect(deletes.coolify).toHaveBeenCalledWith('app-ours');
    expect(deletes.dns).not.toHaveBeenCalled();
    expect(report.counts.deleted).toBe(1);
    expect(report.listFailures).toEqual(['cloudflare-dns: HTTP 403']);
  });

  it('keeps reporting the resources it deliberately left alone', async () => {
    // The skipped/provenance reporting is what stopped the cron deleting an operator's own
    // records by name shape. A listing failure elsewhere must not cost that.
    providers.listZoneARecords.mockResolvedValue([
      { id: 'rec-www', name: 'www.example.com', createdAt: THIRTY_HOURS_AGO, zone: 'example.com' },
    ]);
    providers.listDeployRepos.mockRejectedValue(listingError(404));

    const report = await runOrphanCleanup(NOW);

    expect(deletes.dns).not.toHaveBeenCalled();
    expect(report.skipped.dns).toEqual(['www.example.com']);
    expect(report.listFailures).toEqual(['github-repos: HTTP 404']);
  });

  it('fails the run for a connected Coolify server that did not answer', async () => {
    // The client lists per server and used to swallow a server-level failure, returning the apps
    // it did get. The credential exists and the box did not reply, so whatever is running there
    // is invisible to this run — a failure, not a skip.
    providers.listManagedApplications.mockResolvedValue({
      apps: [{ uuid: 'app-ours', name: 'live-acme', createdAt: THIRTY_HOURS_AGO }],
      unreachable: ['eu-west-1: HTTP 502'],
    });

    const response = await POST(
      new Request('http://localhost/api/cron/cleanup-orphans', { method: 'POST' }),
    );

    expect(response.status).toBe(500);
    expect(cronRuns()[0].ok).toBe(false);
    expect(cronRuns()[0].detail).toContain('coolify server eu-west-1: HTTP 502');
    // Nothing was deleted: no provenance was recorded for that app in this case.
    expect(deletes.coolify).not.toHaveBeenCalled();
  });

  it('does not fail the run for a provider the operator never connected', async () => {
    // A fresh install and every staging app has Cloudflare and GitHub disconnected. The clients
    // throw "…is not connected" there, and treating that as blindness would leave this cron red
    // forever — the alert fatigue this whole change is removing.
    integrations.getIntegration.mockImplementation(async (_workspaceId: string, kind: string) =>
      kind === 'COOLIFY' ? { status: 'CONNECTED', config: {}, secrets: {} } : null,
    );

    const response = await POST(
      new Request('http://localhost/api/cron/cleanup-orphans', { method: 'POST' }),
    );
    const report = await runOrphanCleanup(NOW);

    expect(response.status).toBe(200);
    expect(cronRuns()[0].ok).toBe(true);
    expect(cronRuns()[0].detail).toContain(
      'not connected, so not checked: cloudflare-dns, github-repos',
    );
    expect(report.listFailures).toEqual([]);
    expect(report.notConnected).toEqual(['cloudflare-dns', 'github-repos']);
    // And it never asked those clients anything.
    expect(providers.listZoneARecords).not.toHaveBeenCalled();
    expect(providers.listDeployRepos).not.toHaveBeenCalled();
  });
});
