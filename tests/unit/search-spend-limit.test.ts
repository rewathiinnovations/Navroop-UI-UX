import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WEB_SEARCH_LIMIT,
  allowWebSearch,
  clearWebSearchRateLimits,
} from '@/lib/search/rate-limit';

/**
 * F-319: `POST /api/search` issued a Firecrawl search for 10 results, each
 * scraped for markdown *and* a screenshot, with no rate limit, no quota and no
 * credit cost. Any signed-in member could loop it and spend the operator's
 * Firecrawl balance without limit or attribution.
 */

const auth = vi.hoisted(() => ({ requireSessionUser: vi.fn(), getSessionUser: vi.fn() }));
const credits = vi.hoisted(() => ({ checkCredits: vi.fn(), consumeCredits: vi.fn() }));
const track = vi.hoisted(() => ({ trackFailure: vi.fn() }));

vi.mock('@/lib/auth', () => ({
  ...auth,
  toPublicUser: vi.fn(),
}));
vi.mock('@/lib/search/projects', () => ({ searchProjects: vi.fn() }));
// The money subsystem is not under test here, and it is the one import in this
// route that would otherwise reach a real database.
vi.mock('@/lib/plans/limits', () => credits);
vi.mock('@/lib/observability/track', () => track);
vi.mock('@/lib/storage/usage', () => ({ WORKSPACE_ROW_ID: 'default' }));

const { POST } = await import('@/app/api/search/route');

function searchRequest(body: unknown) {
  return new NextRequest('http://localhost:3000/api/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const firecrawl = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  clearWebSearchRateLimits();
  auth.requireSessionUser.mockResolvedValue({ user: { id: 'member-1', role: 'MEMBER' } });
  credits.checkCredits.mockResolvedValue({ ok: true, cost: 2 });
  credits.consumeCredits.mockResolvedValue(undefined);
  // A fresh Response per call: one shared instance is unusable after the first
  // `.json()`.
  firecrawl.mockImplementation(
    async () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', firecrawl);
  process.env.FIRECRAWL_API_KEY = 'unit-test-key';
});

describe('POST /api/search per-user hourly limit', () => {
  it('stops spending Firecrawl credits once the hourly limit is reached', async () => {
    for (let i = 0; i < WEB_SEARCH_LIMIT; i += 1) {
      const response = await POST(searchRequest({ query: `probe ${i}` }));
      expect(response.status).toBe(200);
    }
    expect(firecrawl).toHaveBeenCalledTimes(WEB_SEARCH_LIMIT);

    const refused = await POST(searchRequest({ query: 'one too many' }));

    expect(refused.status).toBe(429);
    // The point of the limit: no further paid call is made.
    expect(firecrawl).toHaveBeenCalledTimes(WEB_SEARCH_LIMIT);
  });

  it('does not burn a slot on a request that fails validation', async () => {
    for (let i = 0; i < 5; i += 1) {
      const response = await POST(searchRequest({ query: '' }));
      expect(response.status).toBe(400);
    }
    expect(firecrawl).not.toHaveBeenCalled();

    const response = await POST(searchRequest({ query: 'real query' }));
    expect(response.status).toBe(200);
    expect(firecrawl).toHaveBeenCalledTimes(1);
  });

  it('counts per user, so one member cannot exhaust another', async () => {
    for (let i = 0; i < WEB_SEARCH_LIMIT; i += 1) {
      await POST(searchRequest({ query: `probe ${i}` }));
    }
    expect((await POST(searchRequest({ query: 'blocked' }))).status).toBe(429);

    auth.requireSessionUser.mockResolvedValue({ user: { id: 'member-2', role: 'MEMBER' } });
    expect((await POST(searchRequest({ query: 'fresh member' }))).status).toBe(200);
  });

  it('opens a new window an hour later', () => {
    const start = new Date('2026-08-21T10:00:00Z');
    for (let i = 0; i < WEB_SEARCH_LIMIT; i += 1) {
      expect(allowWebSearch('member-3', start).allowed).toBe(true);
    }
    expect(allowWebSearch('member-3', start).allowed).toBe(false);
    expect(allowWebSearch('member-3', new Date('2026-08-21T11:00:01Z')).allowed).toBe(true);
  });
});

describe('POST /api/search is metered', () => {
  it('debits the caller once per successful search', async () => {
    expect((await POST(searchRequest({ query: 'anything' }))).status).toBe(200);

    expect(credits.checkCredits).toHaveBeenCalledWith('default', 'member-1', 'search');
    expect(credits.consumeCredits).toHaveBeenCalledWith('default', 'member-1', 'search');
  });

  it('refuses with 402 when the workspace has no credits left', async () => {
    credits.checkCredits.mockResolvedValue({
      ok: false,
      reason: 'workspace_exhausted',
      used: 100,
      limit: 100,
      message: 'Out of credits',
    });

    const response = await POST(searchRequest({ query: 'anything' }));

    expect(response.status).toBe(402);
    expect(firecrawl).not.toHaveBeenCalled();
    expect(credits.consumeCredits).not.toHaveBeenCalled();
  });

  it('does not charge for a search Firecrawl refused', async () => {
    firecrawl.mockResolvedValue(new Response('nope', { status: 502 }));

    const response = await POST(searchRequest({ query: 'anything' }));

    expect(response.status).toBe(500);
    expect(credits.consumeCredits).not.toHaveBeenCalled();
  });

  it('still answers the caller when the debit itself fails, and tracks it', async () => {
    credits.consumeCredits.mockRejectedValue(new Error('workspace row locked'));

    const response = await POST(searchRequest({ query: 'anything' }));

    expect(response.status).toBe(200);
    expect(track.trackFailure).toHaveBeenCalledWith(
      'credits.search_debit_failed',
      expect.any(Error),
      expect.objectContaining({ action: 'search', userId: 'member-1' }),
    );
  });
});
