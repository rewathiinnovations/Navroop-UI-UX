/**
 * Cross-origin write protection for the API surface (F-350).
 *
 * The product authenticates with an Auth.js JWT session cookie. Until this
 * file existed, nothing under `/api` carried a CSRF token or an origin check:
 * the only thing keeping a cross-site `POST` from arriving with the session
 * cookie attached was Auth.js's default `sameSite: 'lax'` — an inherited
 * default, one line away from being edited (a cross-origin preview embed needs
 * `sameSite: 'none'`) and silently opening every mutation.
 *
 * MECHANISM: an Origin / `Sec-Fetch-Site` check in `proxy.ts`, not a
 * double-submit token. Reasons, in order:
 *
 *  1. Server Actions already have their own protection — Next compares the
 *     `Origin` header against `Host`/`X-Forwarded-Host` on every action POST
 *     and rejects a mismatch — so the same comparison here means one story for
 *     the whole app rather than two mechanisms with two failure modes.
 *  2. It is enforced in one place, for every route, including routes added
 *     tomorrow. A token has to be threaded through every `fetch` call site in
 *     the client, and the endpoint that forgets it is the endpoint that is
 *     vulnerable. `tests/unit/api-csrf-origin.test.ts` drives the real proxy
 *     over every mutating endpoint in the tree; that is only affordable
 *     because coverage is structural.
 *  3. A double-submit token needs a JS-readable cookie, so it is only as
 *     strong as the absence of XSS, and it is exactly as `sameSite`-dependent
 *     as what it replaces.
 *
 * The two signals are checked independently, so neither browser gap matters:
 * every major browser sends `Origin` on a cross-origin state-changing request
 * (including form posts), and `Sec-Fetch-Site` catches a client that omits
 * `Origin`.
 *
 * A request with neither header is not a browser and therefore not a CSRF
 * vector: CSRF is the abuse of a cookie the *browser* attaches on its own. A
 * curl or scheduler call that carries a cookie put there by whoever wrote the
 * command is a stolen-credential problem, not this one, so it is allowed
 * through rather than breaking every non-browser caller (the cron scheduler
 * above all).
 */

/** Methods that can change state, and therefore need the origin check. */
export const STATE_CHANGING_METHODS: Record<string, true> = {
  POST: true,
  PUT: true,
  PATCH: true,
  DELETE: true,
};

export function isStateChangingMethod(method: string) {
  return STATE_CHANGING_METHODS[method.toUpperCase()] === true;
}

/**
 * A state-changing endpoint that is deliberately left reachable cross-origin.
 *
 * Exact paths and one explicit method only — no `:param`, no trailing `/*`. An
 * exemption is a hole punched in the check by hand, and a pattern is how you
 * punch a wider one than you meant to; the same argument
 * `lib/auth/public-routes.ts` makes about listing the Auth.js actions
 * individually rather than as `/api/auth/*`.
 *
 * Empty is the correct state, and is the claim this list exists to make:
 * nothing skips the check. Adding an entry means a browser on another origin
 * may drive that mutation with the caller's cookie, so
 * `tests/unit/mutating-route-authz.test.ts` refuses the entry unless the
 * endpoint's row in that sweep declares the same exemption in writing.
 */
export type OriginCheckExemption = {
  /** Exact request path. */
  pattern: string;
  /** One uppercase HTTP method. */
  method: string;
  /** Why a cross-origin browser may drive this mutation. */
  reason: string;
};

export const ORIGIN_CHECK_EXEMPT: OriginCheckExemption[] = [];

/** What stops a cross-origin browser from driving one endpoint. */
export type CsrfMechanism =
  /** The origin check in `proxy.ts`. */
  | 'proxy-origin-check'
  /** Listed in `ORIGIN_CHECK_EXEMPT`; the check does not run. */
  | 'declared-exempt'
  /** Not a state change, so there is nothing to forge. */
  | 'not-state-changing';

export function csrfMechanismFor(
  method: string,
  pathname: string,
  exemptions: OriginCheckExemption[] = ORIGIN_CHECK_EXEMPT,
): CsrfMechanism {
  if (!isStateChangingMethod(method)) return 'not-state-changing';
  const verb = method.toUpperCase();
  const exempt = exemptions.some(
    (rule) => rule.method.toUpperCase() === verb && rule.pattern === pathname,
  );
  return exempt ? 'declared-exempt' : 'proxy-origin-check';
}

/** Invariants the exemption list has to hold, asserted by the route sweep. */
export function validateOriginCheckExemptions(
  exemptions: OriginCheckExemption[] = ORIGIN_CHECK_EXEMPT,
): string[] {
  const problems: string[] = [];
  for (const rule of exemptions) {
    const at = rule.pattern || '(empty pattern)';
    if (!rule.pattern.startsWith('/')) problems.push(`${at}: pattern must start with "/".`);
    if (rule.pattern.includes('*') || rule.pattern.includes(':')) {
      problems.push(`${at}: exact paths only; a pattern would exempt siblings too.`);
    }
    if (!isStateChangingMethod(rule.method)) {
      problems.push(`${at}: "${rule.method}" is not a state-changing method.`);
    }
    if (rule.method !== rule.method.toUpperCase()) {
      problems.push(`${at}: method "${rule.method}" must be uppercase.`);
    }
    if (!rule.reason.trim()) problems.push(`${at}: reason is empty.`);
  }
  return problems;
}

export type OriginVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Normalize loopback hostnames to a canonical form so 127.0.0.1 and localhost
 * are treated as the same origin for CSRF purposes.
 */
function normalizeLoopbackHost(host: string): string {
  const lower = host.toLowerCase();
  if (lower === '127.0.0.1' || lower === 'localhost' || lower === '[::1]' || lower === '::1') {
    return 'localhost';
  }
  return lower;
}

/** The subset of `Headers` this check reads. */
export type HeaderReader = { get(name: string): string | null };

/**
 * The hosts that count as "this app": whatever the request says it was
 * addressed to. Behind Traefik or Coolify the browser's `Origin` is the public
 * hostname and `Host` / `X-Forwarded-Host` is that same hostname, so they
 * match without any configuration; comparing against a configured `APP_URL`
 * instead would make a misconfigured deployment fail closed on every write.
 *
 * `X-Forwarded-Host` is trusted here because the attacker in a CSRF is a web
 * page, and a page cannot set that header: it is not CORS-safelisted, so the
 * attempt turns the request into a preflight the browser then blocks.
 *
 * Only the host is compared, never the scheme — the app is served plaintext
 * behind a TLS-terminating proxy, so an `https` origin reaching an `http`
 * server is the normal case, not an attack.
 */
function expectedHosts(headers: HeaderReader): Set<string> {
  const hosts = new Set<string>();
  for (const raw of (headers.get('x-forwarded-host') || '').split(',')) {
    const host = normalizeLoopbackHost(raw.trim());
    if (host) hosts.add(host);
  }
  const host = normalizeLoopbackHost((headers.get('host') || '').trim());
  if (host) hosts.add(host);
  return hosts;
}

/**
 * `same-site` is refused alongside `cross-site`: generated previews are served
 * from a sibling hostname of this app precisely so their scripts run on
 * another origin (`lib/preview/headers.ts`), and that content is written by
 * whatever the model produced. A sibling subdomain is not a trusted caller
 * here even though the browser calls it the same site.
 *
 * `none` — a user-initiated request that came from no page at all — is not
 * refused: a cross-site forgery is always reported as `cross-site`, so
 * refusing `none` would only break odd non-browser clients.
 */
const FOREIGN_FETCH_SITES: Record<string, true> = { 'cross-site': true, 'same-site': true };

export function checkRequestOrigin(headers: HeaderReader): OriginVerdict {
  const origin = (headers.get('origin') || '').trim();
  const fetchSite = (headers.get('sec-fetch-site') || '').trim().toLowerCase();

  if (origin) {
    // A sandboxed iframe or a redirected cross-origin post sends the opaque
    // origin. It is not this app.
    if (origin.toLowerCase() === 'null') {
      return { ok: false, reason: 'Origin is the opaque value "null"' };
    }
    let originHost: string;
    try {
      originHost = normalizeLoopbackHost(new URL(origin).host);
    } catch {
      return { ok: false, reason: `Origin is not a URL: ${origin}` };
    }
    if (!originHost) return { ok: false, reason: `Origin has no host: ${origin}` };
    const hosts = expectedHosts(headers);
    if (hosts.size === 0) return { ok: false, reason: 'the request carries no Host header' };
    if (!hosts.has(originHost)) {
      return { ok: false, reason: `Origin host ${originHost} is not this app` };
    }
  }

  if (FOREIGN_FETCH_SITES[fetchSite]) {
    return { ok: false, reason: `Sec-Fetch-Site is ${fetchSite}` };
  }

  return { ok: true };
}
