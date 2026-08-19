import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The orphan cron deletes third-party resources, and the deletion is not reversible.
 * It used to decide ownership from the shape of a name: every A record in the publish
 * zone whose label matched `/^((preview-)?[a-z0-9-]+)$/` and every Coolify app named
 * `live-*`/`preview-*` on any active server was fair game 24 hours after it appeared.
 * An operator's `www` record and another product's app on a shared Coolify host both
 * match. The `created_on ? … : new Date(0)` fallback made it worse: a resource whose
 * listing carried no timestamp was treated as 56 years old, so it was deletable on the
 * first pass.
 *
 * Ownership now comes from what this system recorded when it created the resource, from
 * three sources: the `Deployment` row, the `resourceIds` the publish orchestrator persisted
 * on the PUBLISH job (which outlives a stop), and the `project.hard_purge` audit entry
 * (which is the only one that outlives the `Job.project` cascade a hard purge triggers).
 * Everything else is skipped and reported.
 *
 * Goes red if: ownership is inferred from a name again (the `www` / other-product
 * cases delete); an unknown creation time becomes deletable again; the cron stops
 * reaping resources it did create (the last case in each group); or a hard-purged
 * project's resource becomes unreapable again.
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
const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), logError: vi.fn() }));

vi.mock('@/lib/db', () => ({
  prisma: {
    deployment: { findMany: db.deploymentFindMany },
    job: { findMany: db.jobFindMany },
    appSetting: { upsert: db.appSettingUpsert },
    auditLog: { findMany: db.auditLogFindMany },
  },
}));

vi.mock('@/lib/coolify/client', () => ({
  // The client returns `{ apps, unreachable }` now. Every case in this file varies the app list
  // only, so the mock supplies the app half and no unreachable servers; the server-level failure
  // path lives in `tests/unit/orphan-listing-blind.test.ts`.
  listManagedApplications: async () => ({
    apps: await providers.listManagedApplications(),
    unreachable: [] as string[],
  }),
}));
vi.mock('@/lib/cloudflare/dns', () => ({ listZoneARecords: providers.listZoneARecords }));
vi.mock('@/lib/github/deploy-client', () => ({ listDeployRepos: providers.listDeployRepos }));
// The cron now asks whether a provider is connected before listing it, so that an unconfigured
// Cloudflare or GitHub is reported as "not checked" instead of failing the run. Every case in
// this file is about what happens once a listing has answered, so all three read CONNECTED.
vi.mock('@/lib/integrations/store', () => ({
  getIntegration: async () => ({ status: 'CONNECTED', config: {}, secrets: {} }),
  invalidateIntegrationCache: () => undefined,
}));
vi.mock('@/lib/jobs/compensate', () => ({
  deleteCoolifyApp: deletes.coolify,
  deleteDnsRecord: deletes.dns,
}));
vi.mock('@/lib/logger', () => ({
  log: { debug: vi.fn(), info: logger.info, warn: logger.warn, error: vi.fn() },
  logError: logger.logError,
}));

const { runOrphanCleanup } = await import('@/lib/jobs/orphans.ts');

const NOW = new Date('2026-08-19T12:00:00.000Z');
const LONG_AGO = new Date('2024-01-01T00:00:00.000Z');
const THIRTY_HOURS_AGO = new Date('2026-08-18T06:00:00.000Z');
const AN_HOUR_AGO = new Date('2026-08-19T11:00:00.000Z');

beforeEach(() => {
  db.deploymentFindMany.mockReset();
  db.jobFindMany.mockReset();
  db.appSettingUpsert.mockReset();
  db.auditLogFindMany.mockReset();
  providers.listManagedApplications.mockReset();
  providers.listZoneARecords.mockReset();
  providers.listDeployRepos.mockReset();
  deletes.coolify.mockReset();
  deletes.dns.mockReset();
  logger.info.mockReset();
  logger.warn.mockReset();
  logger.logError.mockReset();

  db.deploymentFindMany.mockResolvedValue([]);
  db.jobFindMany.mockResolvedValue([]);
  db.appSettingUpsert.mockResolvedValue({});
  db.auditLogFindMany.mockResolvedValue([]);
  providers.listManagedApplications.mockResolvedValue([]);
  providers.listZoneARecords.mockResolvedValue([]);
  providers.listDeployRepos.mockResolvedValue([]);
  deletes.coolify.mockResolvedValue(undefined);
  deletes.dns.mockResolvedValue(undefined);
});

describe('cleanup-orphans DNS branch', () => {
  it("leaves an operator's own www record alone, however old it is", async () => {
    providers.listZoneARecords.mockResolvedValue([
      { id: 'rec-www', name: 'www.example.com', createdAt: LONG_AGO, zone: 'example.com' },
      { id: 'rec-mail', name: 'mail.example.com', createdAt: LONG_AGO, zone: 'example.com' },
    ]);

    const report = await runOrphanCleanup(NOW);

    expect(deletes.dns).not.toHaveBeenCalled();
    expect(report.dns).toHaveLength(0);
    expect(report.skipped.dns).toEqual(['www.example.com', 'mail.example.com']);
  });

  it('never deletes a record whose creation time the listing did not carry', async () => {
    // Ours by provenance, so only the missing timestamp stands between it and deletion.
    db.jobFindMany.mockResolvedValue([{ resourceIds: { dnsRecordId: 'rec-undated' } }]);
    providers.listZoneARecords.mockResolvedValue([
      { id: 'rec-undated', name: 'acme.example.com', createdAt: null, zone: 'example.com' },
    ]);

    const report = await runOrphanCleanup(NOW);

    expect(deletes.dns).not.toHaveBeenCalled();
    expect(report.dns).toEqual([
      {
        kind: 'dns',
        action: 'report',
        id: 'rec-undated',
        name: 'acme.example.com',
        createdAt: null,
      },
    ]);
  });

  it('deletes a record publish recorded once its Deployment row is gone and 24h have passed', async () => {
    // Both records are ours; only the grace period separates them.
    db.jobFindMany.mockResolvedValue([
      { resourceIds: { dnsRecordId: 'rec-stale', coolifyAppUuid: null, githubRepo: null } },
      { resourceIds: { dnsRecordId: 'rec-young' } },
    ]);
    providers.listZoneARecords.mockResolvedValue([
      {
        id: 'rec-stale',
        name: 'ghost.example.com',
        createdAt: THIRTY_HOURS_AGO,
        zone: 'example.com',
      },
      { id: 'rec-young', name: 'fresh.example.com', createdAt: AN_HOUR_AGO, zone: 'example.com' },
    ]);

    const report = await runOrphanCleanup(NOW);

    expect(deletes.dns.mock.calls.map((call) => call[0])).toEqual(['rec-stale']);
    expect(report.counts.deleted).toBe(1);
    expect(report.dns.find((row) => row.id === 'rec-young')?.action).toBe('report');
  });

  it('does not touch a record a live Deployment still points at', async () => {
    db.deploymentFindMany.mockResolvedValue([
      { coolifyAppUuid: null, dnsRecordId: 'rec-live', repoFullName: null },
    ]);
    providers.listZoneARecords.mockResolvedValue([
      { id: 'rec-live', name: 'acme.example.com', createdAt: LONG_AGO, zone: 'example.com' },
    ]);

    const report = await runOrphanCleanup(NOW);

    expect(deletes.dns).not.toHaveBeenCalled();
    expect(report.dns).toHaveLength(0);
    expect(report.skipped.dns).toHaveLength(0);
  });
});

describe('cleanup-orphans Coolify branch', () => {
  it("leaves another product's live-* app on a shared server alone", async () => {
    providers.listManagedApplications.mockResolvedValue([
      { uuid: 'app-theirs', name: 'live-otherproduct', createdAt: LONG_AGO },
    ]);

    const report = await runOrphanCleanup(NOW);

    expect(deletes.coolify).not.toHaveBeenCalled();
    expect(report.coolify).toHaveLength(0);
    expect(report.skipped.coolify).toEqual(['live-otherproduct']);
  });

  it('never deletes an app whose creation time the listing did not carry', async () => {
    // `lib/coolify/client.ts` still substitutes the epoch for a missing timestamp, so
    // the guard has to hold for `new Date(0)`, not only for null.
    db.jobFindMany.mockResolvedValue([{ resourceIds: { coolifyAppUuid: 'app-undated' } }]);
    providers.listManagedApplications.mockResolvedValue([
      { uuid: 'app-undated', name: 'live-acme', createdAt: new Date(0) },
    ]);

    const report = await runOrphanCleanup(NOW);

    expect(deletes.coolify).not.toHaveBeenCalled();
    expect(report.coolify[0]).toMatchObject({ action: 'report', createdAt: null });
  });

  it('deletes an app publish recorded once its Deployment row is gone and 24h have passed', async () => {
    db.jobFindMany.mockResolvedValue([
      { resourceIds: { coolifyAppUuid: 'app-stale' } },
      { resourceIds: { coolifyAppUuid: 'app-young' } },
    ]);
    providers.listManagedApplications.mockResolvedValue([
      { uuid: 'app-stale', name: 'live-ghost', createdAt: THIRTY_HOURS_AGO },
      { uuid: 'app-young', name: 'live-fresh', createdAt: AN_HOUR_AGO },
    ]);

    const report = await runOrphanCleanup(NOW);

    expect(deletes.coolify.mock.calls.map((call) => call[0])).toEqual(['app-stale']);
    expect(report.counts.deleted).toBe(1);
    expect(report.coolify.find((row) => row.uuid === 'app-young')?.action).toBe('report');
  });

  it('does not touch an app a live Deployment still points at', async () => {
    db.deploymentFindMany.mockResolvedValue([
      { coolifyAppUuid: 'app-live', dnsRecordId: null, repoFullName: null },
    ]);
    providers.listManagedApplications.mockResolvedValue([
      { uuid: 'app-live', name: 'live-acme', createdAt: LONG_AGO },
    ]);

    const report = await runOrphanCleanup(NOW);

    expect(deletes.coolify).not.toHaveBeenCalled();
    expect(report.coolify).toHaveLength(0);
  });
});

/**
 * The mocks ignore their arguments, so without this the provenance load could be narrowed —
 * `status: 'SUCCEEDED'`, a `createdAt` bound, a `projectId` — and every case above would
 * still pass while the premise failed. The premise is that a receipt outlives the thing it
 * names: a PUBLISH job's `resourceIds` is written the moment the resource is created and
 * matters most when the job FAILED or was ABANDONED half way, and a `project.hard_purge`
 * entry matters for the whole year `pruneAuditLogs` keeps it. Both reads must stay unnarrowed.
 */
describe('cleanup-orphans provenance queries', () => {
  it('reads every PUBLISH job and every hard_purge entry, whatever their status or age', async () => {
    await runOrphanCleanup(NOW);

    expect(db.jobFindMany).toHaveBeenCalledWith({
      where: { kind: 'PUBLISH' },
      select: { resourceIds: true },
    });
    expect(db.auditLogFindMany).toHaveBeenCalledWith({
      where: { action: 'project.hard_purge' },
      select: { after: true },
    });
  });

  it('treats an ABANDONED publish job as a receipt, because that is when it matters most', async () => {
    // The row the query returns carries no status: a half-finished publish created the app
    // and then died, which is precisely the resource nothing else names.
    db.jobFindMany.mockResolvedValue([{ resourceIds: { coolifyAppUuid: 'app-half-built' } }]);
    providers.listManagedApplications.mockResolvedValue([
      { uuid: 'app-half-built', name: 'live-halfbuilt', createdAt: THIRTY_HOURS_AGO },
    ]);

    const report = await runOrphanCleanup(NOW);

    expect(deletes.coolify.mock.calls.map((call) => call[0])).toEqual(['app-half-built']);
    expect(report.skipped.coolify).toEqual([]);
  });
});

/**
 * The case that made the leak permanent rather than merely likely. `Job.project` is
 * `onDelete: Cascade`, so a hard purge takes every PUBLISH receipt with it, and the
 * Deployment row is gone by then too — so a resource the provider reported gone but kept
 * alive (a Coolify 502 on `DELETE /applications/{uuid}`) was named nowhere and was
 * classified `skipped` on every run, forever. `purgeDeletedProjects` copies the ids into its
 * `project.hard_purge` audit entry before the delete; this is the read that acts on them.
 */
describe('cleanup-orphans hard-purge provenance', () => {
  it('reaps a resource named only by the hard_purge audit entry', async () => {
    db.auditLogFindMany.mockResolvedValue([
      {
        after: {
          deployments: [
            {
              coolifyAppUuid: 'app-purged',
              dnsRecordId: 'rec-purged',
              repoFullName: 'org/purged',
            },
          ],
        },
      },
    ]);
    providers.listManagedApplications.mockResolvedValue([
      { uuid: 'app-purged', name: 'live-purged', createdAt: THIRTY_HOURS_AGO },
    ]);
    providers.listZoneARecords.mockResolvedValue([
      {
        id: 'rec-purged',
        name: 'purged.example.com',
        createdAt: THIRTY_HOURS_AGO,
        zone: 'example.com',
      },
    ]);

    const report = await runOrphanCleanup(NOW);

    expect(deletes.coolify.mock.calls.map((call) => call[0])).toEqual(['app-purged']);
    expect(deletes.dns.mock.calls.map((call) => call[0])).toEqual(['rec-purged']);
    expect(report.counts.deleted).toBe(2);
    expect(report.skipped.coolify).toEqual([]);
    expect(report.skipped.dns).toEqual([]);
  });

  it('contributes no ids from an entry an older build wrote', async () => {
    // The read spans a year of history (`pruneAuditLogs` is the bound), so a payload in a
    // shape this parse does not recognise has to contribute nothing — not make a foreign
    // app deletable, and not throw and take the run down with it.
    db.auditLogFindMany.mockResolvedValue([
      { after: null },
      { after: 'legacy string' },
      { after: { reclaimedBytes: 12 } },
      { after: { deployments: 'not-an-array' } },
      { after: { deployments: [null, { coolifyAppUuid: 42 }] } },
    ]);
    providers.listManagedApplications.mockResolvedValue([
      { uuid: 'app-theirs', name: 'live-otherproduct', createdAt: LONG_AGO },
    ]);

    const report = await runOrphanCleanup(NOW);

    expect(deletes.coolify).not.toHaveBeenCalled();
    expect(report.skipped.coolify).toEqual(['live-otherproduct']);
  });
});

describe('cleanup-orphans reporting', () => {
  it('logs what it skipped once per run, with a bounded sample', async () => {
    providers.listZoneARecords.mockResolvedValue(
      Array.from({ length: 25 }, (_, index) => ({
        id: `rec-${index}`,
        name: `host-${index}.example.com`,
        createdAt: LONG_AGO,
        zone: 'example.com',
      })),
    );

    const report = await runOrphanCleanup(NOW);

    expect(report.counts.skipped).toBe(25);
    expect(logger.info).toHaveBeenCalledTimes(1);
    const fields = logger.info.mock.calls[0]?.[1] as { dns: number; sample: string[] };
    expect(fields.dns).toBe(25);
    expect(fields.sample).toHaveLength(10);
  });

  it('bounds the names it persists, but not the count', async () => {
    providers.listZoneARecords.mockResolvedValue(
      Array.from({ length: 60 }, (_, index) => ({
        id: `rec-${index}`,
        name: `host-${index}.example.com`,
        createdAt: LONG_AGO,
        zone: 'example.com',
      })),
    );

    const report = await runOrphanCleanup(NOW);

    // The whole report goes into one AppSetting row and out of the cron response, so a
    // populated zone must not be able to grow either without bound.
    expect(report.counts.skipped).toBe(60);
    expect(report.skipped.dns).toHaveLength(50);
    const persisted = db.appSettingUpsert.mock.calls[0]?.[0] as {
      update: { value: string };
    };
    expect(JSON.parse(persisted.update.value).skipped.dns).toHaveLength(50);
  });

  it('reports a repo it created but never deletes one', async () => {
    db.jobFindMany.mockResolvedValue([{ resourceIds: { githubRepo: 'org/ghost' } }]);
    providers.listDeployRepos.mockResolvedValue([
      { name: 'org/ghost', createdAt: LONG_AGO },
      { name: 'org/unrelated', createdAt: LONG_AGO },
    ]);

    const report = await runOrphanCleanup(NOW);

    expect(report.repos.map((row) => [row.name, row.action])).toEqual([['org/ghost', 'report']]);
    expect(report.skipped.repos).toEqual(['org/unrelated']);
    expect(report.counts.deleted).toBe(0);
  });
});
