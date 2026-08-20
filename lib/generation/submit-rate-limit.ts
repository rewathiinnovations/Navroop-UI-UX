import { createRateLimitStore } from '@/lib/rate-limit/store';

/**
 * A per-member submit limiter for generation.
 *
 * Nothing rate-limited generation before this. What stood in for it was indirect and
 * bypassable: `checkCredits` is a total, not a rate; the `one_active_job_per_project`
 * partial unique index is per **project**, so N projects means N concurrent builds; and the
 * in-memory provider queue is only entered when the request carried a `projectId`. So a
 * loop creating a project and firing one generation each could spend the workspace's whole
 * monthly allowance and the DeepSeek quota as fast as HTTP allows, with the spend ceiling —
 * which trails by the job's own duration — as the only backstop (F-010).
 *
 * Two buckets, both keyed on the member id (the request cannot mint one), and the submit is
 * refused when either is exhausted:
 * - the burst bucket stops a script; a person cannot type ten prompts in a minute;
 * - the hourly bucket bounds sustained spend to something a real session stays inside.
 *
 * Deliberately in front of the credit check: the credit system limits total spend, this
 * limits rate, and they are different controls.
 */
const BURST_WINDOW_MS = 60_000;
const HOUR_MS = 60 * 60 * 1000;

export const GENERATION_BURST_LIMIT = 5;
export const GENERATION_HOURLY_LIMIT = 40;

export const GENERATION_RATE_LIMIT_MESSAGE =
  'Too many builds started just now. Wait a minute and try again.';

const store = createRateLimitStore();

export function allowGenerationSubmit(userId: string, now = new Date()) {
  const ts = now.getTime();
  const burst = store.hit(`burst:${userId}`, GENERATION_BURST_LIMIT, BURST_WINDOW_MS, ts);
  const hourly = store.hit(`hour:${userId}`, GENERATION_HOURLY_LIMIT, HOUR_MS, ts);
  return { allowed: burst.allowed && hourly.allowed, burst: burst.count, hourly: hourly.count };
}

export function clearGenerationSubmitLimits() {
  store.clear();
}
