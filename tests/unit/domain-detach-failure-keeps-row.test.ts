import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A failed Coolify detach must keep the `CustomDomain` row (F-222).
 *
 * Both entry points caught the Coolify error with a `console.warn` and deleted the row anyway.
 * The hostname stayed attached to the Coolify application with nothing naming it: it kept being
 * served with its certificate, no later pass could find it (removal is driven from the rows),
 * and reusing that hostname on another project collided inside Coolify with no explanation.
 * The row is the surviving receipt — the same reasoning `lib/publish/cleanup.ts` already applies
 * to deployment rows.
 *
 * Goes red if: either entry point deletes a row whose detach failed, `removeProjectDomain`
 * reports success on a failed detach or writes the `domain.remove` audit row as if it had
 * worked, or `removeDomainsForDeployment` stops naming the hostnames it could not detach.
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
    { id: 'dom_b', hostname: 'blog.client.test', path: 'A', cloudflareZoneId: null },
  ]);
  coolify.removeApplicationDomain.mockResolvedValue(undefined);
});

describe('removeDomainsForDeployment', () => {
  it('keeps the row and names the hostname when the detach fails', async () => {
    coolify.removeApplicationDomain.mockImplementation(async (_auth, _uuid, hostname: string) => {
      if (hostname === 'shop.client.test') throw new Error('Coolify unreachable');
    });

    const result = await removeDomainsForDeployment(DEPLOYMENT);

    expect(result.removed).toBe(1);
    expect(result.failures).toEqual([
      { hostname: 'shop.client.test', reason: 'Coolify unreachable' },
    ]);
    expect(store.deleteCustomDomainRow).toHaveBeenCalledTimes(1);
    expect(store.deleteCustomDomainRow).toHaveBeenCalledWith('dom_b');
  });

  it('deletes every row when every detach succeeded', async () => {
    const result = await removeDomainsForDeployment(DEPLOYMENT);

    expect(result).toEqual({ removed: 2, failures: [] });
    expect(store.deleteCustomDomainRow).toHaveBeenCalledTimes(2);
  });
});
