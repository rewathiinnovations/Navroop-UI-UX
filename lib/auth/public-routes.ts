/**
 * The allowlist of API paths that may be reached without a session.
 *
 * `proxy.ts` denies every request under `/api` and `/preview-static` by default.
 * A route is reachable unauthenticated only if it matches an entry here, so a
 * newly added route is private the moment it is created. Per-route checks
 * (workspace membership, project ownership, ADMIN role, the deactivated-user
 * check in `getSessionUser`) still run inside the routes — the gate in the
 * proxy is coarse authentication and defence in depth, not a replacement.
 *
 * Adding an entry means deliberately publishing an endpoint to the internet.
 * `scripts/check-public-routes.ts` (wired into `pnpm run verify`) rejects
 * wildcard paths, wildcard methods, and empty `reason` / `ownMechanism`.
 */
export type PublicRouteRule = {
  /** Exact path, or a pattern using `:param` segments and a trailing `/*`. */
  pattern: string;
  /** Explicit uppercase HTTP methods. Never a wildcard. */
  methods: string[];
  /** Why this must be reachable without a session. */
  reason: string;
  /** What protects it instead of a session. */
  ownMechanism: string;
};

/**
 * The nine Auth.js actions below are the complete set served by the
 * `app/api/auth/[...nextauth]` catch-all — see the `actions` array in
 * `@auth/core/lib/utils/actions.js`. They are listed one by one rather than as
 * `/api/auth/*` so the catch-all cannot silently publish a sibling route:
 * `/api/auth/me` sits in the same URL space and must stay private.
 */
export const PUBLIC_API_ROUTES: PublicRouteRule[] = [
  {
    pattern: '/api/auth/providers',
    methods: ['GET'],
    reason: 'Auth.js provider list, read before a session exists.',
    ownMechanism: 'Auth.js handler; exposes provider ids only, no user data.',
  },
  {
    pattern: '/api/auth/session',
    methods: ['GET', 'POST'],
    reason: 'useSession() reads it on every page, including signed out.',
    ownMechanism: 'Auth.js handler; returns an empty session without a valid cookie.',
  },
  {
    pattern: '/api/auth/csrf',
    methods: ['GET'],
    reason: 'signIn() and signOut() fetch the CSRF token before posting.',
    ownMechanism: 'Auth.js double-submit CSRF token.',
  },
  {
    pattern: '/api/auth/signin',
    methods: ['GET', 'POST'],
    reason: 'Auth.js sign-in action; runs before a session exists.',
    ownMechanism: 'Auth.js CSRF token plus provider authorize().',
  },
  {
    pattern: '/api/auth/signin/*',
    methods: ['GET', 'POST'],
    reason: 'Per-provider Auth.js sign-in action.',
    ownMechanism: 'Auth.js CSRF token plus provider authorize().',
  },
  {
    pattern: '/api/auth/callback/*',
    methods: ['GET', 'POST'],
    reason: 'Auth.js provider callback; the credentials sign-in posts here.',
    ownMechanism: 'Auth.js CSRF token and provider state validation.',
  },
  {
    pattern: '/api/auth/signout',
    methods: ['GET', 'POST'],
    reason: 'Sign-out must work even once the session token has expired.',
    ownMechanism: 'Auth.js CSRF token; clears the caller cookie only.',
  },
  {
    pattern: '/api/auth/verify-request',
    methods: ['GET'],
    reason: 'Auth.js verification landing action.',
    ownMechanism: 'Auth.js handler; renders a static message, reads no data.',
  },
  {
    pattern: '/api/auth/error',
    methods: ['GET'],
    reason: 'Auth.js error action, reached when sign-in fails.',
    ownMechanism: 'Auth.js handler; returns an error code, reads no data.',
  },
  {
    pattern: '/api/auth/webauthn-options/*',
    methods: ['GET'],
    reason: 'Auth.js WebAuthn action, part of the catch-all surface.',
    ownMechanism: 'Auth.js handler; no WebAuthn provider is configured.',
  },
  {
    pattern: '/api/auth/login',
    methods: ['POST'],
    reason: 'Signing in is the act of obtaining a session.',
    ownMechanism: 'Password verification plus per-email and per-IP rate limits.',
  },
  {
    pattern: '/api/auth/register',
    methods: ['POST'],
    reason: 'Kept reachable so the closed-registration message is returned, not a 401.',
    // Deliberately not "a single-use invite token": the Invite model has no token column,
    // and nothing in the product creates a claimable invite — `POST /api/admin/invite`
    // creates the User itself and writes the invite already accepted. Self-serve
    // registration does not exist, so this route is closed rather than guarded, and the
    // handler reads no body and touches no table.
    ownMechanism:
      'Always returns 403 without reading the request or the database; accounts come from an admin invite.',
  },
  {
    pattern: '/api/auth/signup',
    methods: ['POST'],
    reason: 'Kept reachable so the disabled-signup message is returned, not a 401.',
    ownMechanism: 'Always returns 403; open signup is disabled.',
  },
  {
    pattern: '/api/auth/logout',
    methods: ['POST'],
    reason: 'Signing out must succeed even after the session token expires.',
    ownMechanism: 'Clears the caller own session cookie and nothing else.',
  },
  {
    pattern: '/api/auth/dev-login',
    methods: ['POST'],
    reason: 'Local quick login for development, used before a session exists.',
    ownMechanism: 'Returns 404 unless dev quick login is explicitly enabled.',
  },
  {
    pattern: '/api/auth/forgot-password',
    methods: ['POST'],
    reason: 'A locked-out user has no session by definition.',
    ownMechanism: 'Generic response for every input, plus per-email and per-IP rate limits.',
  },
  {
    pattern: '/api/auth/reset-password',
    methods: ['POST'],
    reason: 'The reset link is opened without a session.',
    ownMechanism: 'Single-use sha256-hashed token with an expiry.',
  },
  {
    pattern: '/api/health',
    methods: ['GET'],
    reason: 'Docker and Coolify probe liveness before the app is usable.',
    ownMechanism: 'Reports liveness only; no per-user or secret data.',
  },
  {
    pattern: '/api/health/sentry-test',
    methods: ['GET'],
    reason: 'Sentry wiring is checked while diagnosing a broken deployment.',
    ownMechanism: 'Returns 404 unless NODE_ENV is development.',
  },
  {
    pattern: '/api/cron/*',
    methods: ['POST'],
    reason: 'The scheduler calls these from outside any browser session.',
    ownMechanism: 'CRON_SECRET bearer token checked by authorizeCron.',
  },
  {
    pattern: '/api/integrations/sentry/callback',
    methods: ['GET'],
    reason: 'Sentry redirects the OAuth callback back to us.',
    ownMechanism: 'OAuth state parameter minted and verified by us.',
  },
  {
    pattern: '/api/scrape-website',
    methods: ['OPTIONS'],
    reason: 'Browsers send the CORS preflight without credentials.',
    ownMechanism: 'Returns CORS headers only; the POST itself requires a session.',
  },
  {
    pattern: '/preview-static/:projectId',
    methods: ['GET'],
    reason: 'Published static previews are opened by people without an account.',
    ownMechanism: 'Signed 2-hour preview token validated by the route.',
  },
  {
    pattern: '/preview-static/:projectId/*',
    methods: ['GET'],
    reason: 'Assets inside a published static preview.',
    ownMechanism: 'Signed 2-hour preview token validated by the route.',
  },
];

function normalizePath(pathname: string) {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname;
}

function isPattern(pattern: string) {
  return pattern.includes(':') || pattern.endsWith('/*');
}

/**
 * A `:param` segment matches exactly one path segment. A trailing `/*` matches
 * one or more remaining segments. Everything else must match literally.
 */
function pathMatches(pattern: string, pathname: string) {
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');
  const open = patternParts[patternParts.length - 1] === '*';
  const fixed = open ? patternParts.length - 1 : patternParts.length;

  if (open ? pathParts.length <= fixed : pathParts.length !== fixed) return false;

  for (let i = 0; i < fixed; i += 1) {
    const expected = patternParts[i];
    const actual = pathParts[i];
    if (expected.startsWith(':')) {
      if (!actual) return false;
      continue;
    }
    if (expected !== actual) return false;
  }
  return true;
}

/**
 * Resolve a request to its allowlist entry, or null when a session is required.
 *
 * Exact-path rules are considered before pattern rules, so a literal entry
 * always wins over a `:param` or `/*` entry covering the same path. Method
 * matching is exact after uppercasing.
 */
export function matchPublicRoute(pathname: string, method: string): PublicRouteRule | null {
  const path = normalizePath(pathname);
  const verb = method.toUpperCase();

  for (const rule of PUBLIC_API_ROUTES) {
    if (isPattern(rule.pattern)) continue;
    if (normalizePath(rule.pattern) === path && rule.methods.includes(verb)) return rule;
  }

  for (const rule of PUBLIC_API_ROUTES) {
    if (!isPattern(rule.pattern)) continue;
    if (pathMatches(normalizePath(rule.pattern), path) && rule.methods.includes(verb)) return rule;
  }

  return null;
}

const WILDCARD_METHODS = new Set(['*', 'ALL', 'ANY']);

/**
 * Invariants the allowlist has to hold, checked by
 * `scripts/check-public-routes.ts` in the verify gate. A wildcard here would
 * quietly reopen the hole this file exists to close.
 */
export function validatePublicRoutes(rules: PublicRouteRule[] = PUBLIC_API_ROUTES): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const rule of rules) {
    const at = `${rule.pattern || '(empty pattern)'}`;

    if (!rule.pattern.trim()) {
      problems.push('A rule has an empty pattern.');
    } else if (!rule.pattern.startsWith('/')) {
      problems.push(`${at}: pattern must start with "/".`);
    }

    if (
      rule.pattern === '/*' ||
      rule.pattern === '/api/*' ||
      rule.pattern === '/preview-static/*'
    ) {
      problems.push(`${at}: a prefix this broad publishes routes nobody reviewed.`);
    }
    if (rule.pattern.includes('**')) {
      problems.push(`${at}: "**" is not a supported pattern.`);
    }
    const starSegments = rule.pattern.split('/').filter((segment) => segment.includes('*'));
    if (starSegments.some((segment) => segment !== '*')) {
      problems.push(`${at}: "*" must be a whole segment.`);
    }
    if (rule.pattern.split('/').indexOf('*') !== -1 && !rule.pattern.endsWith('/*')) {
      problems.push(`${at}: "*" is only allowed as the final segment.`);
    }

    if (rule.methods.length === 0) {
      problems.push(`${at}: no methods listed.`);
    }
    for (const method of rule.methods) {
      if (WILDCARD_METHODS.has(method.toUpperCase())) {
        problems.push(`${at}: "${method}" is a method wildcard; list each method.`);
      } else if (method !== method.toUpperCase()) {
        problems.push(`${at}: method "${method}" must be uppercase.`);
      }
    }

    if (!rule.reason.trim()) problems.push(`${at}: reason is empty.`);
    if (!rule.ownMechanism.trim()) problems.push(`${at}: ownMechanism is empty.`);

    for (const method of rule.methods) {
      const key = `${method.toUpperCase()} ${rule.pattern}`;
      if (seen.has(key)) problems.push(`${key}: listed twice.`);
      seen.add(key);
    }
  }

  return problems;
}

/** True for the paths the proxy gate covers. */
export function isGuardedApiPath(pathname: string) {
  return (
    pathname === '/api' ||
    pathname.startsWith('/api/') ||
    pathname === '/preview-static' ||
    pathname.startsWith('/preview-static/')
  );
}
