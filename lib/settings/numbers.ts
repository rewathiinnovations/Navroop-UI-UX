import { getSetting } from './resolve';

/**
 * Numeric operator knobs resolved from /admin/config.
 *
 * The repo's own convention is that a value an operator might change without redeploying
 * belongs in admin settings rather than compiled into the image. F-793 listed ~20 such
 * numbers; the ones moved here are the retention and warning *windows*, which is where the
 * convention actually applies: they change what an operator is told and when, they are read
 * on an already-async cron or admin path, and a wrong value degrades a notification rather
 * than a control.
 *
 * What deliberately stays compiled in, so the next reader does not have to re-derive it:
 *
 *  - **Rate limits** — `lib/email/rate-limit.ts` (20/hour), `lib/export/rate-limit.ts`
 *    (5/hour), `lib/password-reset/rate-limit.ts` (3/email, 10/IP). These are abuse controls
 *    on synchronous paths, and an operator-editable ceiling on a password-reset limiter is a
 *    way to disable it by accident. A limit you can raise from a web form is not a limit.
 *  - **Payload budgets** — `lib/audit/bundle.ts` (300 KB / 150 KB). Sized against the model
 *    context the bundle is built for, not against operator preference; raising it produces a
 *    request the provider rejects.
 *  - **Retry ceilings** — `lib/validation/autofix-policy.ts` (2 attempts). Each attempt costs
 *    the user credits, and the cap is the reason a failing autofix terminates at all.
 *  - **Disk floors** — `lib/runtime/data-dir.ts` (2 GB, 20%/10% free). Read during boot
 *    checks, before a database read is safe to depend on.
 *
 * Adding a knob here is two steps: an entry in `registry.ts` (which is what makes it appear
 * on /admin/config) and one `positiveNumberSetting` call at the point of use. Resolve at the
 * point of use, never at module load — a value cached at import time is a setting that
 * appears to apply and does not.
 */

/** Rejects blank, non-numeric and non-positive input, so a cleared field means "default". */
export function positiveNumber(value: string | null | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function positiveNumberSetting(key: string, fallback: number) {
  return positiveNumber(await getSetting(key), fallback);
}

/**
 * A percentage knob: same rejection rules, plus an upper bound of 100. A ratio above 1 would
 * mean "warn me never", which is not a thing the field should be able to express by typo.
 */
export async function percentSetting(key: string, fallback: number) {
  const parsed = await positiveNumberSetting(key, fallback);
  return parsed > 100 ? fallback : parsed;
}
