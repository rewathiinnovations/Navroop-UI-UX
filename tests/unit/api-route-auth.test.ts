import { NextRequest } from 'next/server';
import { encode } from 'next-auth/jwt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { proxy } from '../../proxy';
import {
  PUBLIC_API_ROUTES,
  matchPublicRoute,
  validatePublicRoutes,
  type PublicRouteRule,
} from '../../lib/auth/public-routes';
import { collectRouteEndpoints, samplePath } from '../../lib/auth/route-inventory';

/**
 * The proxy denies `/api` and `/preview-static` by default, so a route added
 * tomorrow is private without anyone remembering to gate it. These tests are
 * what keep that true: they walk the route tree, push every endpoint through
 * the real proxy with no cookies, and pin the resulting public set.
 */

const endpoints = collectRouteEndpoints();

/** Every endpoint reachable without a session, as `METHOD path`. */
const EXPECTED_PUBLIC_ENDPOINTS: string[] = [
  'GET /api/health',
  'GET /api/health/sentry-test',
  'GET /api/integrations/sentry/callback',
  'GET /preview-static/:projectId',
  'GET /preview-static/:projectId/*',
  'OPTIONS /api/scrape-website',
  'POST /api/auth/dev-login',
  'POST /api/auth/forgot-password',
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'POST /api/auth/register',
  'POST /api/auth/reset-password',
  'POST /api/auth/signup',
  'POST /api/cron/backup-db',
  'POST /api/cron/check-certs',
  'POST /api/cron/check-domains',
  'POST /api/cron/check-integrations',
  'POST /api/cron/check-uptime',
  'POST /api/cron/cleanup-orphans',
  'POST /api/cron/observability-heartbeat',
  'POST /api/cron/observability-quota',
  'POST /api/cron/purge-projects',
  'POST /api/cron/reap-jobs',
  'POST /api/cron/sweep-tmp',
  'POST /api/cron/system-checks-digest',
  'POST /api/cron/thin-checkpoints',
  'POST /api/cron/verify-storage',
];

/**
 * The Auth.js catch-all is allowlisted action by action rather than as
 * `/api/auth/*`, so these have to be checked by request path. The list mirrors
 * the `actions` array in `@auth/core/lib/utils/actions.js`; a missing entry
 * breaks sign-in, sign-out, or useSession().
 */
const NEXTAUTH_ENDPOINTS: Array<[string, string]> = [
  ['GET', '/api/auth/providers'],
  ['GET', '/api/auth/session'],
  ['POST', '/api/auth/session'],
  ['GET', '/api/auth/csrf'],
  ['GET', '/api/auth/signin'],
  ['POST', '/api/auth/signin'],
  ['POST', '/api/auth/signin/credentials'],
  ['POST', '/api/auth/callback/credentials'],
  ['GET', '/api/auth/callback/credentials'],
  ['POST', '/api/auth/signout'],
  ['GET', '/api/auth/verify-request'],
  ['GET', '/api/auth/error'],
  ['GET', '/api/auth/webauthn-options/credentials'],
];

function requestFor(method: string, path: string) {
  return new NextRequest(`http://localhost:3000${path}`, { method });
}

describe('api route inventory', () => {
  it('finds the route tree', () => {
    // A walker that silently matches nothing would make every assertion below
    // pass vacuously.
    expect(endpoints.length).toBeGreaterThan(150);
    expect(endpoints.some((row) => row.file === 'app/api/health/route.ts')).toBe(true);
    expect(endpoints.some((row) => row.file.startsWith('app/preview-static/'))).toBe(true);
  });

  it('reads every export style used for handlers', () => {
    const catchAll = endpoints.filter((row) => row.file === 'app/api/auth/[...nextauth]/route.ts');
    expect(catchAll.map((row) => row.method).sort()).toEqual(['GET', 'POST']);

    const named = endpoints.filter((row) => row.file === 'app/api/projects/route.ts');
    expect(named.map((row) => row.method).sort()).toEqual(['GET', 'POST']);
  });
});

describe('deny by default', () => {
  it('every route is allowlisted or answers 401 unauthenticated', async () => {
    const publicEndpoints: string[] = [];
    const notDenied: string[] = [];

    for (const endpoint of endpoints) {
      const path = samplePath(endpoint.pattern);
      const response = await proxy(requestFor(endpoint.method, path));
      if (matchPublicRoute(path, endpoint.method)) {
        publicEndpoints.push(`${endpoint.method} ${endpoint.pattern}`);
        expect(response.status, `${endpoint.method} ${path} is allowlisted`).not.toBe(401);
      } else if (response.status !== 401) {
        notDenied.push(`${endpoint.method} ${endpoint.pattern} (${endpoint.file})`);
      }
    }

    expect(notDenied).toEqual([]);
    expect([...new Set(publicEndpoints)].sort()).toEqual(EXPECTED_PUBLIC_ENDPOINTS);
  });

  it('answers with JSON and a request id, never a redirect', async () => {
    const response = await proxy(requestFor('GET', '/api/projects'));
    expect(response.status).toBe(401);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('x-request-id')).toBeTruthy();

    const body = (await response.json()) as {
      error: { message: string; code: string; requestId: string };
    };
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(body.error.message).toBe('Sign in required');
    expect(body.error.requestId).toBe(response.headers.get('x-request-id'));
  });

  it('reuses an inbound request id so the 401 can be correlated', async () => {
    const request = new NextRequest('http://localhost:3000/api/projects', {
      method: 'GET',
      headers: { 'x-request-id': 'inbound-id-1' },
    });
    const response = await proxy(request);
    expect(response.headers.get('x-request-id')).toBe('inbound-id-1');
  });

  it('denies a route whose own session check was removed', async () => {
    // The point of the gate: deleting `requireSessionUser` from a route no
    // longer makes it public.
    const response = await proxy(requestFor('POST', '/api/generate-ai-code-stream'));
    expect(response.status).toBe(401);
  });

  it('does not let an image extension on a dynamic segment skip the gate', async () => {
    const response = await proxy(requestFor('GET', '/api/projects/anything.png'));
    expect(response.status).toBe(401);
  });

  it('keeps /api/auth/me private', async () => {
    // AuthNav treats any non-ok response as signed out, so a 401 here reads the
    // same as the `{ user: null }` the route already returns when signed out.
    expect(matchPublicRoute('/api/auth/me', 'GET')).toBeNull();
    const response = await proxy(requestFor('GET', '/api/auth/me'));
    expect(response.status).toBe(401);
  });

  it('leaves page routes on their redirect behaviour', async () => {
    const response = await proxy(requestFor('GET', '/dashboard'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('auth=login');
  });
});

describe('a real session token', () => {
  const secret = ['proxy-gate-test', 'value', '32-bytes-long'].join('-');
  const cookieName = 'authjs.session-token';
  let previousSecret: string | undefined;
  let previousNextAuthSecret: string | undefined;

  beforeAll(() => {
    previousSecret = process.env.AUTH_SECRET;
    previousNextAuthSecret = process.env.NEXTAUTH_SECRET;
    process.env.AUTH_SECRET = secret;
    delete process.env.NEXTAUTH_SECRET;
  });

  afterAll(() => {
    if (previousSecret === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = previousSecret;
    if (previousNextAuthSecret === undefined) delete process.env.NEXTAUTH_SECRET;
    else process.env.NEXTAUTH_SECRET = previousNextAuthSecret;
  });

  async function requestWithToken(path: string, token: Record<string, unknown>, maxAge = 60 * 60) {
    // Auth.js derives the encryption key from the cookie name as the HKDF salt,
    // so encoding has to use the same name the proxy looks the cookie up under.
    const jwt = await encode({ token, secret, salt: cookieName, maxAge });
    return new NextRequest(`http://localhost:3000${path}`, {
      method: 'GET',
      headers: { cookie: `${cookieName}=${jwt}` },
    });
  }

  it('passes the gate on a private route', async () => {
    // If the decode in the proxy were wrong, every signed-in API call would
    // 401. This is the test that catches that.
    const response = await proxy(
      await requestWithToken('/api/projects', { id: 'user-1', role: 'MEMBER' }),
    );
    expect(response.status).not.toBe(401);
  });

  it('is rejected once expired', async () => {
    const response = await proxy(await requestWithToken('/api/projects', { id: 'user-1' }, -60));
    expect(response.status).toBe(401);
  });

  it('is rejected when signed with a different secret', async () => {
    const jwt = await encode({
      token: { id: 'user-1' },
      secret: ['a-completely-different', 'value', 'here'].join('-'),
      salt: cookieName,
      maxAge: 3600,
    });
    const request = new NextRequest('http://localhost:3000/api/projects', {
      method: 'GET',
      headers: { cookie: `${cookieName}=${jwt}` },
    });
    expect((await proxy(request)).status).toBe(401);
  });

  it('is rejected when the cookie is not a token at all', async () => {
    const request = new NextRequest('http://localhost:3000/api/projects', {
      method: 'GET',
      headers: { cookie: `${cookieName}=not-a-jwt` },
    });
    expect((await proxy(request)).status).toBe(401);
  });
});

describe('auth.js catch-all', () => {
  it('keeps every Auth.js action reachable without a session', async () => {
    for (const [method, path] of NEXTAUTH_ENDPOINTS) {
      expect(matchPublicRoute(path, method), `${method} ${path}`).not.toBeNull();
      const response = await proxy(requestFor(method, path));
      expect(response.status, `${method} ${path}`).not.toBe(401);
    }
  });

  it('does not publish an unknown sibling under /api/auth', () => {
    expect(matchPublicRoute('/api/auth/whatever', 'GET')).toBeNull();
    expect(matchPublicRoute('/api/auth/session/extra', 'GET')).toBeNull();
  });
});

describe('allowlist rules', () => {
  it('matches methods exactly', () => {
    expect(matchPublicRoute('/api/health', 'GET')).not.toBeNull();
    expect(matchPublicRoute('/api/health', 'POST')).toBeNull();
    expect(matchPublicRoute('/api/health', 'get')).not.toBeNull();
    expect(matchPublicRoute('/api/scrape-website', 'OPTIONS')).not.toBeNull();
    expect(matchPublicRoute('/api/scrape-website', 'POST')).toBeNull();
  });

  it('matches one segment per :param and one or more after a trailing /*', () => {
    expect(matchPublicRoute('/api/cron/reap-jobs', 'POST')).not.toBeNull();
    expect(matchPublicRoute('/api/cron/a/b', 'POST')).not.toBeNull();
    expect(matchPublicRoute('/api/cron', 'POST')).toBeNull();
    expect(matchPublicRoute('/preview-static/proj', 'GET')).not.toBeNull();
    expect(matchPublicRoute('/preview-static/proj/assets/app.js', 'GET')).not.toBeNull();
    expect(matchPublicRoute('/preview-static', 'GET')).toBeNull();
  });

  it('ignores a trailing slash', () => {
    expect(matchPublicRoute('/api/health/', 'GET')).not.toBeNull();
  });

  it('prefers an exact path over a pattern', () => {
    const exact = matchPublicRoute('/api/auth/session', 'GET');
    expect(exact?.pattern).toBe('/api/auth/session');
  });

  it('passes its own validator as shipped', () => {
    expect(validatePublicRoutes()).toEqual([]);
  });

  it('has no rule that matches nothing in the route tree', () => {
    // A rule that no longer corresponds to a route is a hole left open for a
    // path that may be reused later.
    const paths = new Set(endpoints.map((row) => samplePath(row.pattern)));
    // The Auth.js actions live behind one catch-all file, so they are checked
    // against their request paths instead.
    const authActions = NEXTAUTH_ENDPOINTS.map(([, path]) => path);
    const dead = PUBLIC_API_ROUTES.filter((rule) => {
      const candidates = [...paths, ...authActions];
      return !candidates.some((path) =>
        rule.methods.some((method) => matchPublicRoute(path, method) === rule),
      );
    });
    expect(dead.map((rule) => rule.pattern)).toEqual([]);
  });
});

describe('allowlist validator', () => {
  const rule = (overrides: Partial<PublicRouteRule> = {}): PublicRouteRule => ({
    pattern: '/api/health',
    methods: ['GET'],
    reason: 'Liveness probe.',
    ownMechanism: 'No user data.',
    ...overrides,
  });

  it('rejects a bare prefix wildcard', () => {
    expect(validatePublicRoutes([rule({ pattern: '/api/*' })]).join(' ')).toContain(
      'nobody reviewed',
    );
    expect(validatePublicRoutes([rule({ pattern: '/preview-static/*' })]).length).toBeGreaterThan(
      0,
    );
    expect(validatePublicRoutes([rule({ pattern: '/*' })]).length).toBeGreaterThan(0);
  });

  it('rejects a method wildcard', () => {
    expect(validatePublicRoutes([rule({ methods: ['*'] })]).join(' ')).toContain('method wildcard');
    expect(validatePublicRoutes([rule({ methods: ['ALL'] })]).length).toBeGreaterThan(0);
  });

  it('rejects a lowercase method and an empty method list', () => {
    expect(validatePublicRoutes([rule({ methods: ['get'] })]).join(' ')).toContain('uppercase');
    expect(validatePublicRoutes([rule({ methods: [] })]).join(' ')).toContain('no methods listed');
  });

  it('rejects an empty reason or mechanism', () => {
    expect(validatePublicRoutes([rule({ reason: '   ' })]).join(' ')).toContain('reason is empty');
    expect(validatePublicRoutes([rule({ ownMechanism: '' })]).join(' ')).toContain(
      'ownMechanism is empty',
    );
  });

  it('rejects a star that is not a whole trailing segment', () => {
    expect(validatePublicRoutes([rule({ pattern: '/api/auth/sess*' })]).length).toBeGreaterThan(0);
    expect(validatePublicRoutes([rule({ pattern: '/api/*/thing' })]).join(' ')).toContain(
      'final segment',
    );
    expect(validatePublicRoutes([rule({ pattern: '/api/**' })]).length).toBeGreaterThan(0);
  });

  it('rejects a malformed or duplicated entry', () => {
    expect(validatePublicRoutes([rule({ pattern: 'api/health' })]).join(' ')).toContain(
      'must start with',
    );
    expect(validatePublicRoutes([rule(), rule()]).join(' ')).toContain('listed twice');
  });

  it('accepts a well formed entry', () => {
    expect(
      validatePublicRoutes([rule(), rule({ pattern: '/api/cron/*', methods: ['POST'] })]),
    ).toEqual([]);
  });
});
