import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { loginModalHref, signupModalHref } from '@/lib/auth/public-login';

const AUTH_PAGES = new Set(['/login', '/signup']);
const PUBLIC_PAGES = new Set(['/', '/login', '/signup']);

function hasSessionCookie(request: NextRequest) {
  return Boolean(
    request.cookies.get('authjs.session-token')?.value ||
      request.cookies.get('__Secure-authjs.session-token')?.value ||
      request.cookies.get('__Host-authjs.session-token')?.value,
  );
}

export function proxy(request: NextRequest) {
  const session = hasSessionCookie(request);
  const { pathname } = request.nextUrl;

  if (pathname.startsWith('/api/auth')) {
    return NextResponse.next();
  }

  if (pathname === '/signup') {
    if (session) {
      return NextResponse.redirect(new URL('/dashboard', request.url));
    }
    return NextResponse.redirect(new URL(signupModalHref(), request.url));
  }

  if (pathname === '/login') {
    if (session) {
      return NextResponse.redirect(new URL('/dashboard', request.url));
    }
    const next = request.nextUrl.searchParams.get('next');
    return NextResponse.redirect(new URL(loginModalHref(next), request.url));
  }

  if (pathname === '/generation' || pathname.startsWith('/generation/')) {
    const project = request.nextUrl.searchParams.get('project');
    if (project) {
      return NextResponse.redirect(new URL(`/project/${project}`, request.url));
    }
    if (session) {
      return NextResponse.redirect(new URL('/dashboard', request.url));
    }
    return NextResponse.redirect(new URL(loginModalHref(pathname), request.url));
  }

  if (session && AUTH_PAGES.has(pathname)) {
    return NextResponse.redirect(new URL('/dashboard', request.url));
  }

  if (!session && !PUBLIC_PAGES.has(pathname)) {
    const next = pathname === '/' ? null : pathname;
    return NextResponse.redirect(new URL(loginModalHref(next), request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!api/|_next/static|_next/image|_next/data|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
