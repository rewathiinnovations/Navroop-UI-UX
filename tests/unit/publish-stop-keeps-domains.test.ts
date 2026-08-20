import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Which publish-lifecycle operations are allowed to destroy `CustomDomain` rows.
 *
 * Stop and project soft-delete are reversible — the Deployment row survives as `STOPPED`,
 * the project can be restored — yet both called the same cleanup as destroy/purge, which
 * hard-deleted the rows. A single Stop cost the user hostname, verifyToken, expectedTarget
 * and isPrimary, so restoring meant re-adding every hostname and sitting through DNS
 * verification again; for Path B it also destroyed the only pointer to the client's
 * Cloudflare zone, which is deliberately never deleted and so became untracked.
 *
 * Goes red if a reversible path starts deleting rows again, or if a hard delete stops
 * surfacing the Path B zone id that its `CustomDomain` row just took with it.
 */

const db = vi.hoisted(() => ({
  deploymentFindUnique: vi.fn(),
  deploymentUpdate: vi.fn(),
  deploymentDelete: vi.fn(),
  deploymentFindMany: vi.fn(),
  serverFindUnique: vi.fn(),
}));
const domains = vi.hoisted(() => ({
  removeDomainsForDeployment: vi.fn(),
  listCustomDomainsForDeployment: vi.fn(),
}));
const coolify = vi.hoisted(() => ({ stopApplication: vi.fn(), deleteApplication: vi.fn() }));
const logger = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }));

vi.mock('@/lib/db', () => ({
  prisma: {
    deployment: {
      findUnique: db.deploymentFindUnique,
      findMany: db.deploymentFindMany,
      update: db.deploymentUpdate,
      delete: db.deploymentDelete,
    },
    coolifyServer: { findUnique: db.serverFindUnique },
  },
}));
vi.mock('@/lib/domains/cleanup', () => ({
  removeDomainsForDeployment: domains.removeDomainsForDeployment,
}));
vi.mock('@/lib/domains/store', () => ({
  listCustomDomainsForDeployment: domains.listCustomDomainsForDeployment,
}));
vi.mock('@/lib/coolify/client', () => ({
  stopApplication: coolify.stopApplication,
  deleteApplication: coolify.deleteApplication,
}));
vi.mock('@/lib/coolify/servers', () => ({ serverAuth: () => ({ apiUrl: 'x', apiToken: 'y' }) }));
vi.mock('@/lib/cloudflare/dns', () => ({ deleteRecord: vi.fn() }));
vi.mock('@/lib/github/deploy-client', () => ({ deleteDeployRepo: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: logger }));

// Dynamic: cleanup.ts reaches Coolify, Cloudflare and GitHub at import time, so the module
// may only be evaluated after the factories above are registered.
const { destroyDeployment, purgeProjectPublishResources, stopDeployment, stopProjectDeployments } =
  await import('@/lib/publish/cleanup');

const DEPLOYMENT = 'dep_1';
const ROW = {
  id: DEPLOYMENT,
  projectId: 'proj_1',
  workspaceId: 'default',
  serverId: 'srv_1',
  slug: 'shop',
  kind: 'LIVE',
  status: 'LIVE',
  coolifyAppUuid: 'coolify-app-1',
  dnsRecordId: null,
  repoFullName: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  db.deploymentFindUnique.mockResolvedValue(ROW);
  db.deploymentFindMany.mockResolvedValue([ROW]);
  db.deploymentUpdate.mockResolvedValue({ ...ROW, status: 'STOPPED' });
  db.deploymentDelete.mockResolvedValue(ROW);
  db.serverFindUnique.mockResolvedValue({ id: 'srv_1', apiUrl: 'x', apiToken: 'y' });
  // `vi.clearAllMocks()` clears calls but keeps implementations, so a `mockRejectedValue`
  // from a failed-teardown case leaked into every later test in the file. Re-stating the
  // happy-path default here is what keeps each case independent.
  coolify.stopApplication.mockResolvedValue(undefined);
  coolify.deleteApplication.mockResolvedValue(undefined);
  domains.removeDomainsForDeployment.mockResolvedValue(1);
  domains.listCustomDomainsForDeployment.mockResolvedValue([
    { id: 'dom_a', hostname: 'shop.client.test', path: 'B', cloudflareZoneId: 'zone_1' },
    { id: 'dom_b', hostname: 'blog.client.test', path: 'A', cloudflareZoneId: null },
  ]);
});

describe('stopDeployment', () => {
  it('detaches the domains instead of deleting their rows', async () => {
    const result = await stopDeployment(DEPLOYMENT);

    expect(result).toEqual({ stopped: true, deployment: { ...ROW, status: 'STOPPED' } });
    expect(domains.removeDomainsForDeployment).toHaveBeenCalledWith(DEPLOYMENT, {
      deleteRows: false,
    });
    expect(coolify.stopApplication).toHaveBeenCalledTimes(1);
    expect(db.deploymentDelete).not.toHaveBeenCalled();
    expect(db.deploymentUpdate).toHaveBeenCalledWith({
      where: { id: DEPLOYMENT },
      data: { status: 'STOPPED' },
    });
  });

  // Detaching first is what made a failed stop destructive: the hostnames were already
  // off the application when the Coolify error propagated out of the server action.
  it('asks Coolify to stop before it detaches any hostname', async () => {
    const order: string[] = [];
    coolify.stopApplication.mockImplementation(async () => {
      order.push('stop');
    });
    domains.removeDomainsForDeployment.mockImplementation(async () => {
      order.push('detach');
      return 1;
    });

    await stopDeployment(DEPLOYMENT);

    expect(order).toEqual(['stop', 'detach']);
  });

  it('reports a refused stop and leaves the deployment exactly as it was', async () => {
    coolify.stopApplication.mockRejectedValue(new Error('Coolify 502 /applications/stop'));

    const result = await stopDeployment(DEPLOYMENT);

    // Not a throw: the caller needs an answer it can render. The row still says LIVE and
    // the hostnames are still attached, so a retry is the same operation rather than the
    // second half of a half-finished one (F-223).
    expect(result).toEqual({ stopped: false, reason: 'Coolify 502 /applications/stop' });
    expect(domains.removeDomainsForDeployment).not.toHaveBeenCalled();
    expect(db.deploymentUpdate).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'publish.stop_failed',
      expect.objectContaining({ deploymentId: DEPLOYMENT }),
    );
  });
});

describe('stopProjectDeployments', () => {
  it('detaches on soft-delete, so a restore still has its domains', async () => {
    const result = await stopProjectDeployments('proj_1');

    expect(result).toEqual({ stopped: 1, failed: [] });
    expect(domains.removeDomainsForDeployment).toHaveBeenCalledWith(DEPLOYMENT, {
      deleteRows: false,
    });
    expect(db.deploymentDelete).not.toHaveBeenCalled();
  });

  // The soft-delete path used to write STOPPED whatever Coolify said, so the two code
  // paths for one concept disagreed about whether a Coolify failure is fatal (F-223).
  it('does not mark a deployment STOPPED that Coolify refused to stop', async () => {
    coolify.stopApplication.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const result = await stopProjectDeployments('proj_1');

    expect(result).toEqual({
      stopped: 0,
      failed: [{ deploymentId: DEPLOYMENT, reason: 'connect ECONNREFUSED' }],
    });
    expect(db.deploymentUpdate).not.toHaveBeenCalled();
    expect(domains.removeDomainsForDeployment).not.toHaveBeenCalled();
  });

  it('keeps going after one deployment refuses to stop', async () => {
    const second = { ...ROW, id: 'dep_2', coolifyAppUuid: 'coolify-app-2' };
    db.deploymentFindMany.mockResolvedValue([ROW, second]);
    coolify.stopApplication.mockImplementation(async (_auth: unknown, uuid: string) => {
      if (uuid === 'coolify-app-1') throw new Error('nope');
    });

    const result = await stopProjectDeployments('proj_1');

    expect(result.stopped).toBe(1);
    expect(result.failed).toEqual([{ deploymentId: DEPLOYMENT, reason: 'nope' }]);
    expect(db.deploymentUpdate).toHaveBeenCalledWith({
      where: { id: 'dep_2' },
      data: { status: 'STOPPED' },
    });
  });
});

describe('destroyDeployment', () => {
  it('deletes the rows and hands back the Path B zones it could not delete', async () => {
    const destroyed = await destroyDeployment(DEPLOYMENT, { deleteRepo: false });

    // No second argument: the destructive default is what a hard delete wants.
    expect(domains.removeDomainsForDeployment).toHaveBeenCalledWith(DEPLOYMENT);
    expect(db.deploymentDelete).toHaveBeenCalledWith({ where: { id: DEPLOYMENT } });
    // Path A carries no zone of its own, so only the Path B pointer needs rescuing.
    expect(destroyed?.keptCloudflareZones).toEqual([
      { hostname: 'shop.client.test', zoneId: 'zone_1' },
    ]);
    expect(logger.warn).toHaveBeenCalledWith('publish.path_b_zones_kept', {
      deploymentId: DEPLOYMENT,
      zones: [{ hostname: 'shop.client.test', zoneId: 'zone_1' }],
    });
  });

  it('stays quiet when there is no Path B zone to strand', async () => {
    domains.listCustomDomainsForDeployment.mockResolvedValue([
      { id: 'dom_b', hostname: 'blog.client.test', path: 'A', cloudflareZoneId: null },
    ]);

    const destroyed = await destroyDeployment(DEPLOYMENT, { deleteRepo: false });

    expect(destroyed?.keptCloudflareZones).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

/**
 * What has to survive a teardown that only half worked.
 *
 * The orphan cron will only delete a cloud resource whose id this system recorded creating
 * (`lib/jobs/orphans.ts`) — name-shape deletion is not coming back, it deleted operators' own
 * `www`/`api`/`mail` records. So the ids are the whole safety net, and `destroyDeployment`
 * used to swallow a failed provider delete and delete the row anyway: a Coolify 502 left a
 * container running and billing whose uuid existed in no Deployment row and, once the purge
 * cascaded the PUBLISH jobs, in no Job row either. Permanently unreapable.
 *
 * Goes red if a failed provider delete destroys its own receipt again, if a transient error
 * in the Path B zone lookup aborts the teardown, or if the purge path stops handing its
 * caller the ids and zones the `Project` row is about to take with it.
 */
describe('destroyDeployment when a provider delete fails', () => {
  it('keeps the row, because the row is the only thing naming the live resource', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    coolify.deleteApplication.mockRejectedValue(new Error('Coolify 502'));

    const destroyed = await destroyDeployment(DEPLOYMENT, { deleteRepo: false });

    expect(destroyed?.failures).toEqual(['coolify']);
    expect(destroyed?.rowDeleted).toBe(false);
    expect(db.deploymentDelete).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('publish.destroy_incomplete_row_kept', {
      deploymentId: DEPLOYMENT,
      failures: ['coolify'],
    });
  });

  it('deletes the row once every provider has confirmed the resource is gone', async () => {
    const destroyed = await destroyDeployment(DEPLOYMENT, { deleteRepo: false });

    expect(destroyed?.failures).toEqual([]);
    expect(destroyed?.rowDeleted).toBe(true);
    expect(db.deploymentDelete).toHaveBeenCalledWith({ where: { id: DEPLOYMENT } });
  });
});

describe('destroyDeployment Path B zone lookup', () => {
  it('tears down anyway when the lookup throws, and says the zone report was lost', async () => {
    domains.listCustomDomainsForDeployment.mockRejectedValue(new Error('Prisma hiccup'));

    const destroyed = await destroyDeployment(DEPLOYMENT, { deleteRepo: false });

    // The read was the one unguarded statement in the function, so this used to abort the
    // whole teardown before anything was cleaned up.
    expect(domains.removeDomainsForDeployment).toHaveBeenCalledWith(DEPLOYMENT);
    expect(coolify.deleteApplication).toHaveBeenCalledTimes(1);
    expect(destroyed?.rowDeleted).toBe(true);
    // Swallowed, but not silently: losing a Path B zone id has to leave a trace.
    expect(logger.warn).toHaveBeenCalledWith('publish.path_b_zone_lookup_failed', {
      deploymentId: DEPLOYMENT,
      error: 'Prisma hiccup',
    });
  });
});

describe('purgeProjectPublishResources', () => {
  it('hands back the ids and zones the Project row is about to cascade away', async () => {
    db.deploymentFindMany.mockResolvedValue([
      { ...ROW, dnsRecordId: 'rec_1', repoFullName: 'navroop/shop' },
    ]);

    const purged = await purgeProjectPublishResources('proj_1');

    expect(purged.failures).toEqual([]);
    expect(purged.resources).toEqual([
      {
        deploymentId: DEPLOYMENT,
        slug: 'shop',
        kind: 'LIVE',
        coolifyAppUuid: 'coolify-app-1',
        dnsRecordId: 'rec_1',
        repoFullName: 'navroop/shop',
      },
    ]);
    // Used to be discarded entirely on this path, leaving the customer's zone id in a log
    // line that ages out of retention.
    expect(purged.keptCloudflareZones).toEqual([
      { hostname: 'shop.client.test', zoneId: 'zone_1' },
    ]);
  });

  it('reports the failure so the caller refuses to delete the project', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    coolify.deleteApplication.mockRejectedValue(new Error('Coolify 502'));

    const purged = await purgeProjectPublishResources('proj_1');

    expect(purged.failures).toEqual([`${DEPLOYMENT}:coolify`]);
    expect(db.deploymentDelete).not.toHaveBeenCalled();
  });
});
