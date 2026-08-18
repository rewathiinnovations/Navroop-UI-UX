import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { loginModalHref, signupModalHref } from '@/lib/auth/public-login';
import { isGuardedApiPath, matchPublicRoute } from '@/lib/auth/public-routes';
import { createRequestId, REQUEST_ID_HEADER } from '@/lib/request-id';

const AUTH_PAGES = new Set(['/login', '/signup']);
const PUBLIC_PAGES = new Set(['/', '/login', '/signup']);

/**
 * Auth.js writes one of these depending on the cookie prefix it chose at
 * sign-in. The name doubles as the HKDF salt, so the decode below has to reuse
 * the exact name that is present rather than guess from the protocol.
 * Large tokens are split into `<name>.0`, `<name>.1`, … chunks.
 */
const SESSION_COOKIE_NAMES = [
  '__Secure-authjs.session-token',
  '__Host-authjs.session-token',
  'authjs.session-token',
] as const;

function sessionCookieName(request: NextRequest) {
  for (const name of SESSION_COOKIE_NAMES) {
    if (request.cookies.get(name)?.value || request.cookies.get(`${name}.0`)?.value) {
      return name;
    }
  }
  return null;
}

function hasSessionCookie(request: NextRequest) {
  return sessionCookieName(request) !== null;
}

/**
 * Coarse authentication for the API gate: the session token must decrypt with
 * our secret and must not be expired. That is deliberately all this checks.
 *
 * Revocation — a deactivated user, or a session issued before a password
 * change — is NOT checked here. Proxy must not reach the database, and a stale
 * cookie can still carry a valid signature. That check stays where it can read
 * the database: the `jwt` callback in `auth.ts` strips the token identity, and
 * `getSessionUser` in `lib/auth.ts` re-reads `isActive` on every request, so
 * every route and server action rejects a revoked session with 401.
 * `tests/unit/auth-active.test.ts` pins both halves.
 */
async function hasValidSessionToken(request: NextRequest) {
  const cookieName = sessionCookieName(request);
  if (!cookieName) return false;

  const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
  if (!secret) {
    console.error('[proxy] AUTH_SECRET is not set; denying every authenticated API request');
    return false;
  }

  try {
    const token = await getToken({
      req: request,
      secret,
      cookieName,
      secureCookie: cookieName.startsWith('__Secure-') || cookieName.startsWith('__Host-'),
    });
    return token !== null;
  } catch {
    return false;
  }
}

/**
 * API callers get JSON, never a redirect to the login page. The body matches
 * `ApiErrorBody` in `lib/api/error-response.ts`; it is built here rather than
 * imported so the proxy bundle stays free of the request-context store.
 */
function apiUnauthorized(request: NextRequest) {
  const requestId = request.headers.get(REQUEST_ID_HEADER) || createRequestId();
  return NextResponse.json(
    { error: { message: 'Sign in required', code: 'UNAUTHORIZED', requestId } },
    { status: 401, headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}

/**
 * Deny by default. Anything under `/api` or `/preview-static` needs a session
 * unless `PUBLIC_API_ROUTES` names that exact path and method.
 */
async function guardApi(request: NextRequest, pathname: string) {
  if (matchPublicRoute(pathname, request.method)) return nextWithRequestId(request);
  if (await hasValidSessionToken(request)) return nextWithRequestId(request);
  return apiUnauthorized(request);
}

function withRequestId(request: NextRequest, response: NextResponse) {
  const requestId = request.headers.get(REQUEST_ID_HEADER) || createRequestId();
  response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}

function nextWithRequestId(request: NextRequest) {
  const requestId = request.headers.get(REQUEST_ID_HEADER) || createRequestId();
  const headers = new Headers(request.headers);
  headers.set(REQUEST_ID_HEADER, requestId);
  return withRequestId(request, NextResponse.next({ request: { headers } }));
}

export async function proxy(request: NextRequest) {
  const session = hasSessionCookie(request);
  const { pathname } = request.nextUrl;

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return guardApi(request, pathname);
  }

  const host = request.headers.get('host') || '';
  if (host.startsWith('preview-static.')) {
    const url = request.nextUrl.clone();
    if (!url.pathname.startsWith('/preview-static')) {
      url.pathname = `/preview-static${url.pathname === '/' ? '' : url.pathname}`;
    }
    return withRequestId(request, NextResponse.rewrite(url));
  }

  if (isGuardedApiPath(pathname)) {
    return guardApi(request, pathname);
  }

  if (pathname === '/signup') {
    if (session) {
      return withRequestId(request, NextResponse.redirect(new URL('/dashboard', request.url)));
    }
    return withRequestId(request, NextResponse.redirect(new URL(signupModalHref(), request.url)));
  }

  if (pathname === '/login') {
    if (session) {
      return withRequestId(request, NextResponse.redirect(new URL('/dashboard', request.url)));
    }
    const next = request.nextUrl.searchParams.get('next');
    return withRequestId(request, NextResponse.redirect(new URL(loginModalHref(next), request.url)));
  }

  if (session && AUTH_PAGES.has(pathname)) {
    return withRequestId(request, NextResponse.redirect(new URL('/dashboard', request.url)));
  }

  if (!session && !PUBLIC_PAGES.has(pathname)) {
    const next = pathname === '/' ? null : pathname;
    return withRequestId(request, NextResponse.redirect(new URL(loginModalHref(next), request.url)));
  }

  return nextWithRequestId(request);
}

export const config = {
  matcher: [
    // The page matcher below skips anything ending in an image extension. A
    // dynamic segment can end that way too (`/api/projects/logo.png`), so the
    // guarded prefixes are matched unconditionally or the gate would be
    // bypassable by appending an extension.
    '/api/:path*',
    '/preview-static/:path*',
    '/((?!_next/static|_next/image|_next/data|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
