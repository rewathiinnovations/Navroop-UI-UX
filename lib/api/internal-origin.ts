/**
 * NEXT_PUBLIC_APP_URL is this app's own public origin.
 *
 * The generation routes that used to reach their siblings over HTTP are now
 * direct function calls, so nothing routes a request through this value any
 * more. It still has to be right: `lib/integrations/github-manifest.ts` builds
 * the GitHub App Manifest callback from it, and `lib/preview/headers.ts` builds
 * static preview origins from it. Both fail in ways that look like someone
 * else's bug — a GitHub App that installs and never calls back, preview URLs
 * pointing at the wrong host — so the value is asserted at boot instead.
 */

/** The origin used when NEXT_PUBLIC_APP_URL is unset outside production. */
export const INTERNAL_ORIGIN_FALLBACK = 'http://localhost:3000';

export type InternalOriginCheck =
  | { ok: true; origin: string; severity: 'ok' }
  /** Misconfigured: the value we would call is wrong. */
  | { ok: false; origin: string; severity: 'error'; error: string }
  /** Unset: the loopback fallback is used, which works but is not declared. */
  | { ok: false; origin: string; severity: 'warn'; error: string };

function parse(value: string) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Loopback is exempt from the production https rule: `docker-compose.yml` run locally with
 * `NODE_ENV=production` and the `.env.example` default (`http://localhost:3000`) is a
 * supported way to exercise a production image, and nothing on loopback travels a network.
 */
const LOOPBACK_HOSTNAMES: Record<string, true> = {
  localhost: true,
  '127.0.0.1': true,
  '[::1]': true,
  '::1': true,
};

/**
 * NEXT_PUBLIC_APP_URL must parse and must agree with APP_URL (or its
 * NEXTAUTH_URL / AUTH_URL aliases) on *both* scheme and host when one is
 * configured, and must be https in production off loopback.
 *
 * Host alone was not enough (F-764): `http://app.example` beside
 * `https://app.example` passed, and both consumers named at the top of this
 * file build URLs from the value — GitHub rejects an `http` App Manifest
 * callback outright, and an `http` preview origin puts signed preview tokens on
 * the wire in cleartext. Either way the boot check certified the value and the
 * failure surfaced days later as someone else's bug.
 *
 * Being unset is a warning here and is escalated to fatal by
 * `assertInternalOrigin` in production only. docker-compose.yml passes the
 * variable through explicitly, so a production container reaching this branch
 * has an incomplete environment rather than an old deployment.
 */
export function checkInternalOrigin(env: NodeJS.ProcessEnv = process.env): InternalOriginCheck {
  const raw = (env.NEXT_PUBLIC_APP_URL || '').trim();
  if (!raw) {
    return {
      ok: false,
      severity: 'warn',
      origin: INTERNAL_ORIGIN_FALLBACK,
      error: `NEXT_PUBLIC_APP_URL is not set; internal API calls fall back to ${INTERNAL_ORIGIN_FALLBACK}`,
    };
  }

  const origin = parse(raw);
  if (!origin) {
    return {
      ok: false,
      severity: 'error',
      origin: INTERNAL_ORIGIN_FALLBACK,
      error: `NEXT_PUBLIC_APP_URL is not a valid URL: ${raw}`,
    };
  }

  const normalized = raw.replace(/\/+$/, '');
  const appUrl = (env.APP_URL || env.NEXTAUTH_URL || env.AUTH_URL || '').trim();
  if (appUrl) {
    const app = parse(appUrl);
    if (!app) {
      return {
        ok: false,
        severity: 'error',
        origin: normalized,
        error: `APP_URL is not a valid URL: ${appUrl}`,
      };
    }
    if (app.host !== origin.host) {
      return {
        ok: false,
        severity: 'error',
        origin: normalized,
        error: `NEXT_PUBLIC_APP_URL host (${origin.host}) does not match APP_URL host (${app.host})`,
      };
    }
    if (app.protocol !== origin.protocol) {
      return {
        ok: false,
        severity: 'error',
        origin: normalized,
        error: `NEXT_PUBLIC_APP_URL scheme (${origin.protocol}) does not match APP_URL scheme (${app.protocol})`,
      };
    }
  }

  if (
    env.NODE_ENV === 'production' &&
    origin.protocol !== 'https:' &&
    !LOOPBACK_HOSTNAMES[origin.hostname]
  ) {
    return {
      ok: false,
      severity: 'error',
      origin: normalized,
      error: `NEXT_PUBLIC_APP_URL must be https in production: ${normalized}`,
    };
  }

  return { ok: true, severity: 'ok', origin: normalized };
}

/**
 * Boot check.
 *
 * In production any problem — unset, unparseable, a different host or scheme
 * than APP_URL, or a non-https origin off loopback — throws and the app refuses
 * to start. A container that
 * boots with the wrong public origin serves a GitHub App callback and preview
 * URLs that point somewhere else, and that is discovered days later by a user,
 * not by us. Failing at boot puts it in the deploy log instead.
 *
 * Outside production it only logs, so local dev without the variable is
 * unaffected.
 */
export function assertInternalOrigin(env: NodeJS.ProcessEnv = process.env) {
  const result = checkInternalOrigin(env);
  if (result.ok) return result;

  if (env.NODE_ENV === 'production') {
    throw new Error(`[internal-origin] ${result.error}`);
  }

  if (result.severity === 'error') {
    console.error(`[internal-origin] ${result.error}`);
  } else {
    console.warn(`[internal-origin] ${result.error}`);
  }
  return result;
}
