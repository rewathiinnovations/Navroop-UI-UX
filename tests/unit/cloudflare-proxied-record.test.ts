import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-249: `upsertARecord` short-circuited on `existing.content === ip` alone.
 *
 * The payload it would have written asks for `proxied: true` and `ttl: 1` — the orange
 * cloud. A record switched to grey by hand, or by another tool, still matched on content,
 * so publish reported the DNS step succeeded while the site was served straight off the
 * origin: no WAF, origin IP exposed, and a different certificate story. "Could not look" is
 * already handled; this is "we looked and it is not what we asked for".
 *
 * Goes red if the content-only comparison comes back, or if a record that already matches
 * on every field we care about starts being rewritten on every publish.
 */

const integration = vi.hoisted(() => ({ getIntegration: vi.fn(), getRootDomain: vi.fn() }));

vi.mock('@/lib/integrations/store', () => ({
  getIntegration: integration.getIntegration,
  getRootDomain: integration.getRootDomain,
}));

const { upsertARecord } = await import('@/lib/cloudflare/dns.ts');

const fetchMock = vi.fn();

type Call = { method: string; url: string; body: Record<string, unknown> | null };

function json(data: unknown) {
  return new Response(JSON.stringify({ success: true, result: data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Answers the list call with `existing`, then records whatever write follows. */
function zoneWith(existing: Record<string, unknown> | null) {
  const calls: Call[] = [];
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const method = (init?.method || 'GET').toUpperCase();
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ method, url, body });
    if (method === 'GET') return Promise.resolve(json(existing ? [existing] : []));
    return Promise.resolve(json({ id: 'rec-written' }));
  });
  return calls;
}

const PROXIED = {
  id: 'rec-1',
  name: 'acme.example.com',
  type: 'A',
  content: '203.0.113.10',
  proxied: true,
  ttl: 1,
};

beforeEach(() => {
  integration.getIntegration.mockReset();
  integration.getIntegration.mockResolvedValue({
    status: 'CONNECTED',
    config: { zoneId: 'zone-1', zoneName: 'example.com' },
    secrets: { token: 'cf-token' },
  });
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('upsertARecord asserts the orange cloud, not only the IP', () => {
  it('re-proxies a record that was switched to grey cloud behind our back', async () => {
    const calls = zoneWith({ ...PROXIED, proxied: false, ttl: 300 });

    await expect(upsertARecord('acme', '203.0.113.10')).resolves.toBe('rec-written');

    const write = calls.find((call) => call.method === 'PUT');
    expect(write?.url).toContain('/dns_records/rec-1');
    expect(write?.body?.proxied).toBe(true);
    expect(write?.body?.ttl).toBe(1);
  });

  it('rewrites a record whose ttl drifted off the proxied sentinel', async () => {
    const calls = zoneWith({ ...PROXIED, ttl: 3600 });

    await upsertARecord('acme', '203.0.113.10');

    expect(calls.some((call) => call.method === 'PUT')).toBe(true);
  });

  it('rewrites a record that no longer points at the server', async () => {
    const calls = zoneWith({ ...PROXIED, content: '198.51.100.1' });

    await upsertARecord('acme', '203.0.113.10');

    const write = calls.find((call) => call.method === 'PUT');
    expect(write?.body?.content).toBe('203.0.113.10');
  });

  it('leaves a record that already matches every field alone', async () => {
    const calls = zoneWith(PROXIED);

    await expect(upsertARecord('acme', '203.0.113.10')).resolves.toBe('rec-1');

    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('creates a proxied record when the zone has none', async () => {
    const calls = zoneWith(null);

    await expect(upsertARecord('acme', '203.0.113.10')).resolves.toBe('rec-written');

    const write = calls.find((call) => call.method === 'POST');
    expect(write?.body).toMatchObject({
      type: 'A',
      name: 'acme.example.com',
      content: '203.0.113.10',
      proxied: true,
      ttl: 1,
    });
  });
});
