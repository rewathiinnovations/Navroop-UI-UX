import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-207: a domain change must never ship a hostname list missing the site's own address.
 *
 * `setApplicationPrimaryRedirects` **replaces** the Coolify application's whole
 * `domains`/`fqdn` list. `applyPrimaryRedirects` built that list from `peekRootDomain`,
 * which returns null unless the Cloudflare integration is CONNECTED — and with
 * `zone === null` the publish hostname `{slug}.{zone}` was simply never added, so the PATCH
 * removed it. A live customer site lost its canonical address as a side effect of an
 * unrelated Cloudflare state, from a cron with nobody watching.
 *
 * Two contracts are pinned:
 *
 *  - zone unknown -> no PATCH at all, and a recorded reason naming Cloudflare. This is the
 *    mirror of the read-modify-write discipline `addApplicationDomain` already has: a write
 *    that cannot enumerate every hostname that must stay attached does not run.
 *  - zone known -> the list is merged with what the application already answers, so a host
 *    attached outside this code path survives.
 */

const store = vi.hoisted(() => ({ peekRootDomain: vi.fn() }));
const domains = vi.hoisted(() => ({
  listCustomDomainsForDeployment: vi.fn(),
  updateCustomDomain: vi.fn(),
}));
const db = vi.hoisted(() => ({ deploymentFindUnique: vi.fn() }));
const logger = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }));

vi.mock('@/lib/db', () => ({ prisma: { deployment: { findUnique: db.deploymentFindUnique } } }));
vi.mock('@/lib/integrations/store', () => ({ peekRootDomain: store.peekRootDomain }));
vi.mock('@/lib/domains/store', () => ({
  listCustomDomainsForDeployment: domains.listCustomDomainsForDeployment,
  updateCustomDomain: domains.updateCustomDomain,
}));
vi.mock('@/lib/logger', () => ({ log: logger }));
vi.mock('@/lib/coolify/servers', () => ({
  serverAuth: () => ({ apiUrl: 'https://coolify.example.com', apiToken: 'plain-token' }),
}));

const DEPLOYMENT = 'dep-1';
const APP = 'coolify-app-1';
const ZONE = 'navroop.example.com';
const PUBLISH_HOST = `live-shop.${ZONE}`;

type Call = { method: string; body: Record<string, unknown> | null };
const calls: Call[] = [];
let fqdn = '';

function domainRow(overrides: Record<string, unknown>) {
  return {
    id: 'cd-1',
    deploymentId: DEPLOYMENT,
    workspaceId: 'ws',
    hostname: 'shop.client.test',
    status: 'ACTIVE',
    verifyToken: 'tok',
    expectedTarget: '1.2.3.4',
    lastCheckedAt: null,
    lastError: null,
    sslIssuedAt: null,
    isPrimary: true,
    path: 'A',
    cloudflareZoneId: null,
    nameservers: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  fqdn = `https://${PUBLISH_HOST}`;
  db.deploymentFindUnique.mockResolvedValue({
    id: DEPLOYMENT,
    workspaceId: 'ws',
    slug: 'live-shop',
    kind: 'LIVE',
    coolifyAppUuid: APP,
    server: { id: 's1' },
  });
  domains.listCustomDomainsForDeployment.mockResolvedValue([domainRow({})]);
  domains.updateCustomDomain.mockResolvedValue(domainRow({}));
  store.peekRootDomain.mockResolvedValue(ZONE);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      calls.push({ method, body });
      if (method === 'PATCH') {
        fqdn = String(body?.fqdn ?? '');
        return new Response(JSON.stringify({ uuid: APP }), { status: 200 });
      }
      return new Response(JSON.stringify({ uuid: APP, fqdn }), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the zone cannot be resolved', () => {
  it('writes nothing at all', async () => {
    store.peekRootDomain.mockResolvedValue(null);
    const { applyPrimaryRedirects } = await import('@/lib/domains/redirects');

    const result = await applyPrimaryRedirects(DEPLOYMENT);

    expect(result).toMatchObject({ ok: false });
    // The whole finding: this PATCH used to ship a list without `{slug}.{zone}` on it.
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([]);
    expect(fqdn).toBe(`https://${PUBLISH_HOST}`);
  });

  it('records why, on the domain the user is looking at', async () => {
    store.peekRootDomain.mockResolvedValue(null);
    const { applyPrimaryRedirects } = await import('@/lib/domains/redirects');

    await applyPrimaryRedirects(DEPLOYMENT);

    expect(domains.updateCustomDomain).toHaveBeenCalledTimes(1);
    const [id, data] = domains.updateCustomDomain.mock.calls[0] as [
      string,
      { lastError?: string | null },
    ];
    expect(id).toBe('cd-1');
    expect(data.lastError).toMatch(/cloudflare/i);
    // No secrets in a persisted, user-visible message (F-208).
    expect(data.lastError).not.toContain('tok');
  });
});

describe('the zone is known', () => {
  it('keeps the site own hostname and any host attached outside this path', async () => {
    fqdn = `https://${PUBLISH_HOST},https://ops.internal.test`;
    const { applyPrimaryRedirects } = await import('@/lib/domains/redirects');

    const result = await applyPrimaryRedirects(DEPLOYMENT);

    expect(result).toMatchObject({ ok: true });
    const patch = calls.find((call) => call.method === 'PATCH');
    const sent = String(patch?.body?.fqdn ?? '');
    expect(sent).toContain('https://shop.client.test');
    expect(sent).toContain(`https://${PUBLISH_HOST}:redirect`);
    expect(sent).toContain('https://ops.internal.test:redirect');
    // Coolify reads both keys; sending only one leaves the other stale.
    expect(patch?.body?.domains).toBe(patch?.body?.fqdn);
  });

  it('still drops a custom domain this system knows is no longer live', async () => {
    fqdn = `https://${PUBLISH_HOST},https://old.client.test`;
    domains.listCustomDomainsForDeployment.mockResolvedValue([
      domainRow({}),
      domainRow({ id: 'cd-2', hostname: 'old.client.test', status: 'FAILED', isPrimary: false }),
    ]);
    const { applyPrimaryRedirects } = await import('@/lib/domains/redirects');

    await applyPrimaryRedirects(DEPLOYMENT);

    const sent = String(calls.find((call) => call.method === 'PATCH')?.body?.fqdn ?? '');
    expect(sent).not.toContain('old.client.test');
  });
});
