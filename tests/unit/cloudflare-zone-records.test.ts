import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `listZoneARecords` is the orphan cron's inventory of the publish zone. It used to
 * substitute `new Date(0)` when Cloudflare returned a record without `created_on`, which
 * read as "created in 1970" — past every grace period — so an undated record was
 * deletable the first time the cron saw it. Unknown age must stay unknown; the caller
 * (`lib/jobs/orphans.ts`) refuses to delete anything it cannot date.
 *
 * Goes red if the epoch fallback comes back, or if the listing starts pretending to be
 * filtered to records Navroop created (it is the whole zone, by design — ownership is
 * decided against recorded ids, not against these rows).
 */

const integration = vi.hoisted(() => ({ getIntegration: vi.fn(), getRootDomain: vi.fn() }));

vi.mock('@/lib/integrations/store', () => ({
  getIntegration: integration.getIntegration,
  getRootDomain: integration.getRootDomain,
}));

const { listZoneARecords } = await import('@/lib/cloudflare/dns.ts');

const fetchMock = vi.fn();

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

describe('listZoneARecords', () => {
  it('reports an undated record as undated instead of as ancient', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          result: [
            {
              id: 'rec-dated',
              name: 'acme.example.com',
              type: 'A',
              content: '1.2.3.4',
              created_on: '2026-08-18T06:00:00.000Z',
            },
            { id: 'rec-undated', name: 'www.example.com', type: 'A', content: '1.2.3.4' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const records = await listZoneARecords();

    expect(records.map((row) => [row.id, row.createdAt])).toEqual([
      ['rec-dated', new Date('2026-08-18T06:00:00.000Z')],
      ['rec-undated', null],
    ]);
  });
});
