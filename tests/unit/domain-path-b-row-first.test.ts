import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Path B reserves the database row before it provisions Cloudflare (F-221).
 *
 * The zone and its records were created first and `insertCustomDomain` ran last, so a
 * `DuplicateHostnameError` from a concurrent add — or any database error — left a zone on the
 * account with nothing in the product referencing it. Every teardown path deliberately never
 * deletes a zone and reports it from `CustomDomain.cloudflareZoneId`, so an orphan is invisible
 * to /admin and accumulates.
 *
 * Goes red if: Cloudflare is called before the row exists, a duplicate hostname reaches
 * Cloudflare, or a provisioning failure deletes the row or loses the zone id receipt.
 */

const store = vi.hoisted(() => ({
  findCustomDomainByHostname: vi.fn(),
  insertCustomDomain: vi.fn(),
  updateCustomDomain: vi.fn(),
  deleteCustomDomainRow: vi.fn(),
}));
const cloudflare = vi.hoisted(() => ({
  createOrGetClientZone: vi.fn(),
  upsertClientZoneRecord: vi.fn(),
}));
const calls = vi.hoisted(() => ({ order: [] as string[] }));

class DuplicateHostnameError extends Error {}

vi.mock('@/lib/db', () => ({
  prisma: {
    project: { findFirst: vi.fn(async () => ({ id: 'proj_1' })) },
    deployment: {
      findFirst: vi.fn(async () => ({
        id: 'dep_1',
        workspaceId: 'ws_1',
        slug: 'acme',
        kind: 'LIVE',
        server: { serverIp: '203.0.113.10' },
      })),
    },
  },
}));
vi.mock('@/lib/integrations/store', () => ({ peekRootDomain: vi.fn(async () => 'navroop.test') }));
vi.mock('@/lib/plans/limits', () => ({
  checkCustomDomainAllowed: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/lib/cloudflare/zones', () => ({
  createOrGetClientZone: cloudflare.createOrGetClientZone,
  upsertClientZoneRecord: cloudflare.upsertClientZoneRecord,
}));
vi.mock('@/lib/domains/store', () => ({
  DuplicateHostnameError,
  findCustomDomainByHostname: store.findCustomDomainByHostname,
  insertCustomDomain: store.insertCustomDomain,
  updateCustomDomain: store.updateCustomDomain,
  deleteCustomDomainRow: store.deleteCustomDomainRow,
}));

const { createCustomDomain } = await import('@/lib/domains/create.ts');

const BASE_ROW = {
  id: 'dom_1',
  deploymentId: 'dep_1',
  workspaceId: 'ws_1',
  hostname: 'client.co.in',
  status: 'PENDING_DNS' as const,
  verifyToken: 'token',
  expectedTarget: '203.0.113.10',
  lastCheckedAt: null,
  lastError: null,
  sslIssuedAt: null,
  isPrimary: false,
  path: 'B' as const,
  cloudflareZoneId: null,
  nameservers: null,
  createdAt: new Date('2026-08-20T12:00:00.000Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  calls.order = [];
  store.findCustomDomainByHostname.mockResolvedValue(null);
  store.insertCustomDomain.mockImplementation(async () => {
    calls.order.push('insert');
    return { ...BASE_ROW };
  });
  store.updateCustomDomain.mockImplementation(
    async (_id: string, data: Record<string, unknown>) => {
      calls.order.push(`update:${Object.keys(data).sort().join(',')}`);
      return { ...BASE_ROW, ...data };
    },
  );
  cloudflare.createOrGetClientZone.mockImplementation(async () => {
    calls.order.push('zone');
    return { zoneId: 'zone_1', nameservers: ['ns1.test', 'ns2.test', 'ns3.test'] };
  });
  cloudflare.upsertClientZoneRecord.mockImplementation(async () => {
    calls.order.push('record');
  });
});

describe('createCustomDomain on Path B', () => {
  it('inserts the row before touching Cloudflare and records the zone id before the records', async () => {
    const result = await createCustomDomain({
      projectId: 'proj_1',
      hostname: 'client.co.in',
      path: 'B',
    });

    expect(result.ok).toBe(true);
    expect(calls.order[0]).toBe('insert');
    expect(calls.order[1]).toBe('zone');
    expect(calls.order[2]).toBe('update:cloudflareZoneId');
    expect(calls.order.slice(3)).toEqual(['record', 'record', 'update:nameservers']);
    expect(cloudflare.createOrGetClientZone).toHaveBeenCalledWith('client.co.in', 'ws_1');
  });

  it('keeps the row with the zone id and an error when provisioning fails midway', async () => {
    cloudflare.upsertClientZoneRecord.mockRejectedValue(new Error('Cloudflare said no'));

    const result = await createCustomDomain({
      projectId: 'proj_1',
      hostname: 'client.co.in',
      path: 'B',
    });

    expect(result.ok).toBe(false);
    expect(store.deleteCustomDomainRow).not.toHaveBeenCalled();
    const zoneWrite = store.updateCustomDomain.mock.calls.find(
      (call) => (call[1] as Record<string, unknown>).cloudflareZoneId === 'zone_1',
    );
    expect(zoneWrite).toBeTruthy();
    const errorWrite = store.updateCustomDomain.mock.calls.find(
      (call) => typeof (call[1] as Record<string, unknown>).lastError === 'string',
    );
    expect(String((errorWrite?.[1] as Record<string, unknown>).lastError)).toContain(
      'Cloudflare said no',
    );
  });

  it('refuses a duplicate hostname before any Cloudflare call', async () => {
    store.findCustomDomainByHostname.mockResolvedValue({ ...BASE_ROW, deploymentId: 'dep_other' });

    const result = await createCustomDomain({
      projectId: 'proj_1',
      hostname: 'client.co.in',
      path: 'B',
    });

    expect(result.ok).toBe(false);
    expect(cloudflare.createOrGetClientZone).not.toHaveBeenCalled();
    expect(store.insertCustomDomain).not.toHaveBeenCalled();
  });

  it('refuses a race that only the unique index can catch, still before Cloudflare', async () => {
    store.insertCustomDomain.mockRejectedValue(
      new DuplicateHostnameError('This hostname is already in use'),
    );

    const result = await createCustomDomain({
      projectId: 'proj_1',
      hostname: 'client.co.in',
      path: 'B',
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.status).toBe(409);
    expect(cloudflare.createOrGetClientZone).not.toHaveBeenCalled();
  });

  it('refuses Path B for a hostname whose registrable domain is unknown', async () => {
    const result = await createCustomDomain({
      projectId: 'proj_1',
      hostname: 'client.co.zz',
      path: 'B',
    });

    expect(result.ok).toBe(false);
    expect(store.insertCustomDomain).not.toHaveBeenCalled();
    expect(cloudflare.createOrGetClientZone).not.toHaveBeenCalled();
  });

  it('resumes provisioning for a row that was left without a zone', async () => {
    store.findCustomDomainByHostname.mockResolvedValue({ ...BASE_ROW, cloudflareZoneId: null });

    const result = await createCustomDomain({
      projectId: 'proj_1',
      hostname: 'client.co.in',
      path: 'B',
    });

    expect(result.ok).toBe(true);
    expect(store.insertCustomDomain).not.toHaveBeenCalled();
    expect(cloudflare.createOrGetClientZone).toHaveBeenCalledTimes(1);
  });
});
