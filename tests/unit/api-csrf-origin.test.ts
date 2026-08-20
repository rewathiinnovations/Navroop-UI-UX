import { NextRequest } from 'next/server';
import { encode } from 'next-auth/jwt';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { proxy } from '../../proxy';
import {
  ORIGIN_CHECK_EXEMPT,
  checkRequestOrigin,
  csrfMechanismFor,
  isStateChangingMethod,
  validateOriginCheckExemptions,
} from '../../lib/auth/csrf';
import { collectRouteEndpoints, samplePath } from '../../lib/auth/route-inventory';

/**
 * F-350: nothing stopped a cookie-authenticated state change from being driven
 * by another origin. The only thing standing in the way was Auth.js's default
 * `sameSite: 'lax'` — inherited, undocumented, and one edit away from opening
 * every mutation at once.
 *
 * `lib/auth/csrf.ts` now states the protection and `proxy.ts` enforces it for
 * the whole API surface, so these tests are what make it real:
 *
 *  1. The decision function, exercised on the header combinations a browser
 *     actually sends.
 *  2. The real proxy, on every mutating endpoint in the route tree: with a
 *     valid session cookie and a foreign `Origin`, all of them are refused.
 *     Structural coverage is the point — a route added tomorrow is included
 *     without anyone remembering it.
 *  3. The paths that must NOT change: reads, signed-out callers, the cron
 *     scheduler, and Server Action posts to page routes (Next does its own
 *     Origin/Host comparison there; the API gate never sees them).
 */

const APP_ORIGIN = 'http://localhost:3000';
const APP_HOST = 'localhost:3000';
const EVIL_ORIGIN = 'https://attacker.example';
/** A sibling hostname of the app: where generated previews are served. */
const PREVIEW_ORIGIN = 'http://preview-static.localhost:3000';

describe('checkRequestOrigin', () => {
  it('accepts a request whose Origin is this app', () => {
    expect(checkRequestOrigin(new Headers({ origin: APP_ORIGIN, host: APP_HOST }))).toEqual({
      ok: true,
    });
  });

  it('accepts an https Origin in front of a plaintext app behind a TLS proxy', () => {
    // Traefik terminates TLS and forwards http, so the scheme never matches.
    // Comparing it would refuse every write in production.
    expect(
      checkRequestOrigin(
        new Headers({
          origin: 'https://app.example',
          host: 'app.example',
          'x-forwarded-proto': 'https',
        }),
      ),
    ).toEqual({ ok: true });
  });

  it('accepts the forwarded host a reverse proxy names', () => {
    expect(
      checkRequestOrigin(
        new Headers({
          origin: 'https://app.example',
          host: 'app-internal:3000',
          'x-forwarded-host': 'app.example',
        }),
      ),
    ).toEqual({ ok: true });
  });

  it('refuses a foreign Origin', () => {
    const verdict = checkRequestOrigin(new Headers({ origin: EVIL_ORIGIN, host: APP_HOST }));
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain('attacker.example');
  });

  it('refuses the opaque "null" Origin a sandboxed frame sends', () => {
    expect(checkRequestOrigin(new Headers({ origin: 'null', host: APP_HOST })).ok).toBe(false);
  });

  it('refuses an Origin that is not a URL', () => {
    expect(checkRequestOrigin(new Headers({ origin: 'not a url', host: APP_HOST })).ok).toBe(false);
  });

  it('refuses a cross-site fetch that sent no Origin at all', () => {
    // The second signal, independent of the first: a client that omits Origin
    // is still caught by the fetch metadata every current browser sends.
    const verdict = checkRequestOrigin(
      new Headers({ host: APP_HOST, 'sec-fetch-site': 'cross-site' }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain('cross-site');
  });

  it('refuses same-site, because generated previews run on a sibling hostname', () => {
    // The preview host serves model-written scripts on purpose
    // (lib/preview/headers.ts). The browser calls that the same site; this app
    // does not call it a trusted caller.
    expect(checkRequestOrigin(new Headers({ origin: PREVIEW_ORIGIN, host: APP_HOST })).ok).toBe(
      false,
    );
    expect(
      checkRequestOrigin(new Headers({ host: APP_HOST, 'sec-fetch-site': 'same-site' })).ok,
    ).toBe(false);
  });

  it('accepts a same-origin fetch that declares itself as one', () => {
    expect(
      checkRequestOrigin(
        new Headers({ origin: APP_ORIGIN, host: APP_HOST, 'sec-fetch-site': 'same-origin' }),
      ),
    ).toEqual({ ok: true });
  });

  it('accepts a client that sends neither header', () => {
    // curl, the cron scheduler, a container health probe. A cookie such a
    // caller carries was put there by whoever wrote the command; that is a
    // stolen credential, not a forgery, and refusing it would break every
    // non-browser caller for no gain.
    expect(checkRequestOrigin(new Headers({ host: APP_HOST }))).toEqual({ ok: true });
  });

  it('refuses an Origin when the request names no host to compare it to', () => {
    expect(checkRequestOrigin(new Headers({ origin: APP_ORIGIN })).ok).toBe(false);
  });
});

describe('which endpoints the check covers', () => {
  it('covers exactly the state-changing methods', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
      expect(isStateChangingMethod(method), method).toBe(true);
    }
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(isStateChangingMethod(method), method).toBe(false);
    }
  });

  it('exempts nothing today, and any exemption has to be well formed', () => {
    expect(ORIGIN_CHECK_EXEMPT).toEqual([]);
    expect(validateOriginCheckExemptions()).toEqual([]);
    expect(csrfMechanismFor('POST', '/api/projects')).toBe('proxy-origin-check');
    expect(csrfMechanismFor('GET', '/api/projects')).toBe('not-state-changing');
  });

  it('reports an exemption as an exemption, and rejects a sloppy one', () => {
    // Anti-vacuity for the assertion above and for the sweep in
    // mutating-route-authz.test.ts: with an entry present the mechanism really
    // does change, so "proxy-origin-check" is a finding, not a constant.
    const exemptions = [{ pattern: '/api/projects', method: 'POST', reason: 'test only' }];
    expect(csrfMechanismFor('POST', '/api/projects', exemptions)).toBe('declared-exempt');
    expect(csrfMechanismFor('DELETE', '/api/projects', exemptions)).toBe('proxy-origin-check');
    expect(csrfMechanismFor('POST', '/api/projects/x', exemptions)).toBe('proxy-origin-check');

    expect(
      validateOriginCheckExemptions([
        { pattern: '/api/projects/*', method: 'post', reason: '' },
        { pattern: 'api/x', method: 'GET', reason: 'r' },
      ]),
    ).toEqual([
      '/api/projects/*: exact paths only; a pattern would exempt siblings too.',
      '/api/projects/*: method "post" must be uppercase.',
      '/api/projects/*: reason is empty.',
      'api/x: pattern must start with "/".',
      'api/x: "GET" is not a state-changing method.',
    ]);
  });
});

describe('the proxy refuses a cookie-authenticated cross-origin write', () => {
  const secret = ['csrf-origin-test', 'value', '32-bytes-long'].join('-');
  const cookieName = 'authjs.session-token';
  let previousSecret: string | undefined;
  let previousNextAuthSecret: string | undefined;
  let cookie = '';

  beforeAll(async () => {
    previousSecret = process.env.AUTH_SECRET;
    previousNextAuthSecret = process.env.NEXTAUTH_SECRET;
    process.env.AUTH_SECRET = secret;
    delete process.env.NEXTAUTH_SECRET;
    // Auth.js uses the cookie name as the HKDF salt, so the encode has to name
    // the cookie the proxy will look the token up under.
    const jwt = await encode({
      token: { id: 'user-1', role: 'MEMBER' },
      secret,
      salt: cookieName,
      maxAge: 60 * 60,
    });
    cookie = `${cookieName}=${jwt}`;
    // One warn line per refusal, and the sweep below makes a hundred of them.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterAll(() => {
    vi.restoreAllMocks();
    if (previousSecret === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = previousSecret;
    if (previousNextAuthSecret === undefined) delete process.env.NEXTAUTH_SECRET;
    else process.env.NEXTAUTH_SECRET = previousNextAuthSecret;
  });

  function request(method: string, path: string, extra: Record<string, string> = {}) {
    return new NextRequest(`${APP_ORIGIN}${path}`, {
      method,
      headers: { cookie, host: APP_HOST, ...extra },
    });
  }

  it('refuses a foreign Origin with 403 and a request id', async () => {
    const response = await proxy(request('POST', '/api/projects', { origin: EVIL_ORIGIN }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: 'CROSS_ORIGIN_REFUSED', message: 'Cross-origin request refused' },
    });
    expect(response.headers.get('x-request-id')).toBeTruthy();
    // Never a redirect: API callers get JSON, same contract as the 401.
    expect(response.headers.get('location')).toBeNull();
  });

  it('refuses a cross-site fetch that sent no Origin', async () => {
    const response = await proxy(
      request('DELETE', '/api/projects/p-1', { 'sec-fetch-site': 'cross-site' }),
    );
    expect(response.status).toBe(403);
  });

  it('refuses the preview hostname, which serves generated scripts', async () => {
    const response = await proxy(request('POST', '/api/projects', { origin: PREVIEW_ORIGIN }));
    expect(response.status).toBe(403);
  });

  it('lets the app itself through', async () => {
    for (const extra of [
      { origin: APP_ORIGIN },
      { origin: APP_ORIGIN, 'sec-fetch-site': 'same-origin' },
      {},
    ]) {
      const response = await proxy(request('POST', '/api/projects', extra));
      expect(response.status, JSON.stringify(extra)).not.toBe(403);
      expect(response.status, JSON.stringify(extra)).not.toBe(401);
    }
  });

  it('leaves reads alone', async () => {
    // A cross-origin GET cannot be read back without CORS, and refusing one
    // would break nothing an attacker needs — the finding is about writes.
    const response = await proxy(request('GET', '/api/projects', { origin: EVIL_ORIGIN }));
    expect(response.status).not.toBe(403);
  });

  it('still answers 401, not 403, when there is no session to abuse', async () => {
    // Order inside the gate: authentication first. A signed-out caller must
    // keep getting the 401 the rest of the gate's tests pin.
    const response = await proxy(
      new NextRequest(`${APP_ORIGIN}/api/projects`, {
        method: 'POST',
        headers: { host: APP_HOST, origin: EVIL_ORIGIN },
      }),
    );
    expect(response.status).toBe(401);
  });

  it('leaves the cron scheduler alone', async () => {
    // No cookie, no Origin, its own CRON_SECRET. Adding the origin check must
    // not turn every scheduled run into a 403.
    const response = await proxy(
      new NextRequest(`${APP_ORIGIN}/api/cron/reap-jobs`, {
        method: 'POST',
        headers: { host: APP_HOST },
      }),
    );
    expect(response.status).not.toBe(403);
    expect(response.status).not.toBe(401);
  });

  it('leaves Server Action posts to page routes alone', async () => {
    // Next compares Origin against Host for Server Actions itself, and those
    // posts go to a page path, not `/api`. The gate must not double-guess it —
    // including when the action is invoked from the app's own origin.
    for (const extra of [{ origin: APP_ORIGIN }, { origin: EVIL_ORIGIN }]) {
      const response = await proxy(
        new NextRequest(`${APP_ORIGIN}/dashboard`, {
          method: 'POST',
          headers: { cookie, host: APP_HOST, 'next-action': 'abc123', ...extra },
        }),
      );
      expect(response.status, JSON.stringify(extra)).not.toBe(403);
    }
  });

  it('refuses a cross-origin write on every mutating endpoint in the tree', async () => {
    const mutating = collectRouteEndpoints().filter((endpoint) =>
      isStateChangingMethod(endpoint.method),
    );
    // Anti-vacuity: an empty walk would satisfy the loop below. F-313 measured
    // this surface at ~113 endpoints.
    expect(mutating.length).toBeGreaterThanOrEqual(110);

    const allowed: string[] = [];
    const refusedFromOwnOrigin: string[] = [];
    for (const endpoint of mutating) {
      const path = samplePath(endpoint.pattern);
      const foreign = await proxy(request(endpoint.method, path, { origin: EVIL_ORIGIN }));
      if (foreign.status !== 403) allowed.push(`${endpoint.method} ${endpoint.pattern}`);
      // And the same request from the app itself is not refused, so the loop
      // above cannot be passing because the gate refuses everything.
      const own = await proxy(request(endpoint.method, path, { origin: APP_ORIGIN }));
      if (own.status === 403) refusedFromOwnOrigin.push(`${endpoint.method} ${endpoint.pattern}`);
    }
    expect(allowed.join(' | ')).toBe('');
    expect(refusedFromOwnOrigin.join(' | ')).toBe('');
  });
});
