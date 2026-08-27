import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * What an idle workspace costs at rest.
 *
 * Measured with a fetch interceptor in a live tab, build finished, job SUCCEEDED,
 * nothing happening: twelve `GET /api/auth/session` in 34 seconds — one every 2.8
 * seconds, each re-running the Auth.js callbacks and re-reading the user row from
 * Postgres. Two mechanisms produced it, and both are wiring rather than logic, so
 * these are source assertions: the suite runs in the `node` environment with no
 * jsdom and no testing-library, so there is nothing here that can mount a provider
 * and re-render it to observe identity.
 *
 * 1. `app/providers.tsx` mounted `<SessionProvider>` with no props at all, so
 *    NextAuth's `refetchOnWindowFocus` default of true made every focus and
 *    visibility change a full session round trip, echoed to other tabs over the
 *    BroadcastChannel.
 * 2. `AuthProvider` rebuilt its `AuthUser` on every render (`fromSession(session?.user)`
 *    straight in the render body) and keyed `refresh` on NextAuth's `update`, which
 *    is itself re-created on every session change. The context value therefore
 *    changed identity on every render and every `useAuth()` consumer re-rendered on
 *    a poll that had told us nothing new.
 *
 * The interval is not a security trade-off: revocation is enforced per request on
 * the server — `getSessionUser` re-reads `isActive` before any route answers, and
 * the `jwt` callback re-reads `isActive` and `passwordChangedAt` on every `auth()`
 * — so a stale client session authorises nothing. That reasoning has to stay
 * written next to the props, which the last case checks.
 */

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function source(relative: string) {
  return readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

const PROVIDERS = source('app/providers.tsx');
const AUTH_PROVIDER = source('components/app/auth/AuthProvider.tsx');

/** The opening tag of `<SessionProvider …>`, props and all. */
function sessionProviderTag() {
  const match = /<SessionProvider(\s[^>]*)?>/.exec(PROVIDERS);
  expect(match, 'app/providers.tsx mounts SessionProvider').not.toBeNull();
  return match?.[1] ?? '';
}

describe('the session provider is mounted with an explicit refetch policy', () => {
  it('does not refetch the session on every window focus', () => {
    expect(sessionProviderTag()).toMatch(/refetchOnWindowFocus=\{false\}/);
  });

  it('states its refetch interval rather than inheriting a default', () => {
    expect(sessionProviderTag()).toMatch(/refetchInterval=\{[^}]+\}/);
  });

  it('does not spin session requests while the browser is offline', () => {
    expect(sessionProviderTag()).toMatch(/refetchWhenOffline=\{false\}/);
  });

  it('keeps the revocation reasoning next to the props', () => {
    // A number with no argument is the thing that gets "tuned" later by someone
    // who cannot tell whether it is load-bearing for security.
    expect(PROVIDERS).toMatch(/getSessionUser/);
    expect(PROVIDERS).toMatch(/isActive/);
  });
});

describe("AuthProvider's context value survives an unchanged session", () => {
  it('memoises the user on the session fields, not on the session object', () => {
    // The old line, exactly: a new AuthUser per render, listed in the value memo.
    expect(AUTH_PROVIDER).not.toMatch(/const user = fromSession\(/);
    expect(AUTH_PROVIDER).toMatch(/const user = useMemo\(/);
  });

  it('does not put a session object in any dependency array', () => {
    // Every hook dependency array in the file: the `[…]` that closes a `useMemo` /
    // `useCallback` / `useEffect` call. Comments are stripped first — the note above
    // `refresh` quotes NextAuth's own `useMemo(…, [session, loading])`, and prose
    // about the bug must not read as the bug.
    const code = AUTH_PROVIDER.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const deps = [...code.matchAll(/,\s*\[([^[\]]*)\]\s*,?\s*\)/g)].map((match) =>
      (match[1] ?? '').split(',').map((entry) => entry.trim()),
    );
    expect(deps.length, 'AuthProvider memoises something').toBeGreaterThan(0);
    for (const list of deps) {
      expect(list).not.toContain('session');
      expect(list).not.toContain('session?.user');
      expect(list).not.toContain('sessionUser');
    }
  });

  it('keeps refresh stable across session changes', () => {
    // NextAuth re-creates `update` whenever the session object changes — its own
    // context value is `useMemo(…, [session, loading])` — so depending on it put
    // the churn straight back into the value this provider hands down.
    expect(AUTH_PROVIDER).toMatch(/updateRef\.current\(\)/);
    const refreshDeps = /const refresh = useCallback\([\s\S]*?\},\s*\[([^\]]*)\]\s*\)/.exec(
      AUTH_PROVIDER,
    );
    expect(refreshDeps, 'refresh is a useCallback').not.toBeNull();
    expect(refreshDeps?.[1].trim()).toBe('');
  });

  it('keeps signOutUser stable too', () => {
    const signOutDeps = /const signOutUser = useCallback\([\s\S]*?\},\s*\[([^\]]*)\]\s*\)/.exec(
      AUTH_PROVIDER,
    );
    expect(signOutDeps, 'signOutUser is a useCallback').not.toBeNull();
    expect(signOutDeps?.[1].trim()).toBe('');
  });
});
