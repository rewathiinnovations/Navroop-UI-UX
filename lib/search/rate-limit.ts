import { createRateLimitStore } from '@/lib/rate-limit/store';

/**
 * F-319: `POST /api/search` issues a Firecrawl search for 10 results with
 * `markdown` and `screenshot` scraping *per result* — the most expensive
 * third-party call in the product per request. It had no rate limit, no quota and
 * no credit cost, so any signed-in member could loop it and spend the operator's
 * Firecrawl balance without limit.
 *
 * The same shape as `allowExport`: a per-user hourly bucket. It uses the bounded
 * store rather than a bare `Map` so the keys cannot accumulate for the process
 * lifetime.
 */

const HOUR_MS = 60 * 60 * 1000;
export const WEB_SEARCH_LIMIT = 10;
export const WEB_SEARCH_RATE_LIMIT_MESSAGE = 'Web search limit reached — try again in an hour';

const store = createRateLimitStore();

export function allowWebSearch(userId: string, now = new Date()) {
  return store.hit(`user:${userId}`, WEB_SEARCH_LIMIT, HOUR_MS, now.getTime());
}

export function clearWebSearchRateLimits() {
  store.clear();
}
