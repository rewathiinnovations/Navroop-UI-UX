/**
 * An internal destination, or null.
 *
 * Resolved with the same parser the browser will use rather than checked with
 * string prefixes, because the prefix version rejected `//evil.com` and admitted
 * `/\evil.com`. A URL with a special scheme treats a backslash as a path
 * separator (WHATWG URL), so a browser reads that second form as `//evil.com` and
 * leaves the origin; tabs and newlines are stripped before parsing, so `/\u0009/evil.com`
 * reassembles into an authority too. That was a latent open redirect while the only
 * consumer was `AuthModal`'s client-side `router.push`, and became a live one the
 * moment `app/page.tsx` began issuing a server-side `redirect()` with this value —
 * a 307 to somebody else's site with our own sign-in as the referrer.
 *
 * The origin is a throwaway: it only has to be a host this app can never be, so
 * that "the value resolved somewhere else" is detectable.
 */
export function safeNextPath(value: string | null | undefined) {
  if (!value) return null;
  if (!value.startsWith('/')) return null;

  const origin = 'https://next-path.invalid';
  let resolved: URL;
  try {
    resolved = new URL(value, origin);
  } catch {
    return null;
  }
  if (resolved.origin !== origin) return null;

  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

export function loginModalHref(next?: string | null) {
  const params = new URLSearchParams({ auth: 'login' });
  const safe = safeNextPath(next);
  if (safe) params.set('next', safe);
  return `/?${params.toString()}`;
}

export function signupModalHref(next?: string | null) {
  const params = new URLSearchParams({ auth: 'signup' });
  const safe = safeNextPath(next);
  if (safe) params.set('next', safe);
  return `/?${params.toString()}`;
}
