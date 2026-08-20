import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Stopping a deployment must detach its custom domains, not destroy them.
 *
 * `removeDomainsForDeployment` was one routine doing two jobs: it removed the hostname from
 * the Coolify app *and* hard-deleted the `CustomDomain` row. Stop and project soft-delete are
 * reversible — the deployment row survives as `STOPPED`, the project can be restored — yet
 * they called the same irreversible cleanup as destroy/purge, so a Stop lost hostname,
 * verifyToken, expectedTarget, isPrimary and, for Path B, the only pointer to the client's
 * Cloudflare zone. `deleteRows: false` keeps the rows so a restore or re-publish can
 * re-attach them; the default stays destructive for destroy and purge.
 *
 * Goes red if: the flag stops being honoured in either direction, or the detach path starts
 * writing to the rows (no schema exists for a detached marker this run).
 */

const db = vi.hoisted(() => ({ deploymentFindUnique: vi.fn() }));
const coolify = vi.hoisted(() => ({ removeApplicationDomain: vi.fn() }));
const store = vi.hoisted(() => ({
  listCustomDomainsForDeployment: vi.fn(),
  deleteCustomDomainRow: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ prisma: { deployment: { findUnique: db.deploymentFindUnique } } }));
vi.mock('@/lib/coolify/client', () => ({
  removeApplicationDomain: coolify.removeApplicationDomain,
}));
vi.mock('@/lib/coolify/servers', () => ({
  serverAuth: () => ({ baseUrl: 'https://coolify.test', token: 'stub' }),
}));
vi.mock('@/lib/domains/store', () => ({
  listCustomDomainsForDeployment: store.listCustomDomainsForDeployment,
  deleteCustomDomainRow: store.deleteCustomDomainRow,
}));

const { removeDomainsForDeployment } = await import('@/lib/domains/cleanup.ts');

const DEPLOYMENT = 'dep_stop';

beforeEach(() => {
  vi.clearAllMocks();
  db.deploymentFindUnique.mockResolvedValue({
    id: DEPLOYMENT,
    coolifyAppUuid: 'app-uuid',
    server: { id: 'srv_1' },
  });
  store.listCustomDomainsForDeployment.mockResolvedValue([
    { id: 'dom_a', hostname: 'shop.client.test', path: 'B', cloudflareZoneId: 'zone_1' },
  ]);
  coolify.removeApplicationDomain.mockResolvedValue(undefined);
});

describe('removeDomainsForDeployment', () => {
  it('detaches from Coolify and keeps the rows when deleteRows is false', async () => {
    const result = await removeDomainsForDeployment(DEPLOYMENT, { deleteRows: false });

    expect(result).toEqual({ removed: 0, failures: [] });
    expect(coolify.removeApplicationDomain).toHaveBeenCalledWith(
      expect.anything(),
      'app-uuid',
      'shop.client.test',
    );
    expect(store.deleteCustomDomainRow).not.toHaveBeenCalled();
  });

  it('still deletes the rows by default, for destroy and purge', async () => {
    await removeDomainsForDeployment(DEPLOYMENT);

    expect(coolify.removeApplicationDomain).toHaveBeenCalledTimes(1);
    expect(store.deleteCustomDomainRow).toHaveBeenCalledWith('dom_a');
  });
});
