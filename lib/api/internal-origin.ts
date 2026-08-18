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

function hostOf(value: string) {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

/**
 * NEXT_PUBLIC_APP_URL must parse and must point at the same host as APP_URL
 * (or its NEXTAUTH_URL / AUTH_URL aliases) when one is configured.
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

  const originHost = hostOf(raw);
  if (!originHost) {
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
    const appHost = hostOf(appUrl);
    if (!appHost) {
      return {
        ok: false,
        severity: 'error',
        origin: normalized,
        error: `APP_URL is not a valid URL: ${appUrl}`,
      };
    }
    if (appHost !== originHost) {
      return {
        ok: false,
        severity: 'error',
        origin: normalized,
        error: `NEXT_PUBLIC_APP_URL host (${originHost}) does not match APP_URL host (${appHost})`,
      };
    }
  }

  return { ok: true, severity: 'ok', origin: normalized };
}

/**
 * Boot check.
 *
 * In production any problem — unset, unparseable, or pointing at a different
 * host than APP_URL — throws and the app refuses to start. A container that
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
