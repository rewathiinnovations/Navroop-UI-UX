/**
 * Bounded in-process bucket store shared by the unauthenticated rate limiters
 * (login, forgot-password). Both endpoints are public, so the store must not
 * grow with attacker-chosen keys (F-709, F-304):
 *
 * - expired buckets are swept on every call, so a burst does not linger for
 *   the process lifetime;
 * - the map is capped at `maxEntries`; when full, the least-recently-touched
 *   bucket is evicted. Eviction (rather than falling closed) means a key-flood
 *   can at worst reset a counter early — it can never lock every new client
 *   out of signing in.
 *
 * Per-process by nature: with N replicas the effective limit is N x the
 * configured one. That is the same trade the previous Maps made.
 */

export const MAX_RATE_LIMIT_ENTRIES = 10_000;

type Bucket = { count: number; resetAt: number };

export type RateLimitStore = {
  /** Counts a hit for `key`; a new window opens when the previous one expired. */
  hit(
    key: string,
    limit: number,
    windowMs: number,
    nowMs: number,
  ): { allowed: boolean; count: number };
  delete(key: string): void;
  clear(): void;
  size(): number;
};

export function createRateLimitStore(maxEntries = MAX_RATE_LIMIT_ENTRIES): RateLimitStore {
  const buckets = new Map<string, Bucket>();

  function sweep(nowMs: number) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= nowMs) buckets.delete(key);
    }
  }

  return {
    hit(key, limit, windowMs, nowMs) {
      sweep(nowMs);
      const existing = buckets.get(key);
      if (!existing) {
        if (buckets.size >= maxEntries) {
          // Evict the least-recently-touched bucket (first in insertion order —
          // hits below re-insert, so order tracks recency).
          const oldest = buckets.keys().next().value;
          if (oldest !== undefined) buckets.delete(oldest);
        }
        buckets.set(key, { count: 1, resetAt: nowMs + windowMs });
        return { allowed: true, count: 1 };
      }
      existing.count += 1;
      // Re-insert so insertion order reflects recency and active buckets are
      // not the ones evicted under a key-flood.
      buckets.delete(key);
      buckets.set(key, existing);
      return { allowed: existing.count <= limit, count: existing.count };
    },
    delete(key) {
      buckets.delete(key);
    },
    clear() {
      buckets.clear();
    },
    size() {
      return buckets.size;
    },
  };
}
