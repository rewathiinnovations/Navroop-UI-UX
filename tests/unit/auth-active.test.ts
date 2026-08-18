import type { NextAuthConfig, Session, User } from 'next-auth';
import type { JWT } from 'next-auth/jwt';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role } from '@/generated/prisma';

/**
 * Revocation is checked in the route layer, not in the proxy.
 *
 * The proxy gate added in `proxy.ts` only verifies that the session token
 * decrypts and has not expired — it cannot reach the database. A deactivated
 * user still holds a signed cookie, so these two checks are what actually
 * reject them, and this file exists so the refactor cannot quietly drop either:
 *
 *   1. `getSessionUser` re-reads `isActive` on every request.
 *   2. The `jwt` callback in `auth.ts` strips the token identity for an
 *      inactive user, or for a token issued before a password change.
 *
 * Both halves are exercised as behaviour. An earlier version of this file
 * checked the `jwt` callback with regexes against the text of `auth.ts`, which
 * stayed green if the body of the `if` were emptied, the condition inverted, or
 * the whole callback made unreachable — and went red on reformatting.
 *
 * The harness stubs `next-auth` itself so `auth.ts` executes for real and hands
 * over the config it registers. That gives the real `jwt` and `session`
 * callbacks, and control of `auth()` for the `getSessionUser` half.
 */

const nextAuthMock = vi.hoisted(() => ({
  config: null as unknown,
  calls: 0,
  auth: vi.fn(),
}));
const dbMock = vi.hoisted(() => ({ findUnique: vi.fn() }));

vi.mock('next-auth', () => ({
  default: (config: unknown) => {
    nextAuthMock.config = config;
    nextAuthMock.calls += 1;
    return {
      handlers: {},
      auth: nextAuthMock.auth,
      signIn: vi.fn(),
      signOut: vi.fn(),
      unstable_update: vi.fn(),
    };
  },
}));

vi.mock('@auth/prisma-adapter', () => ({ PrismaAdapter: () => ({}) }));

vi.mock('@/lib/db', () => ({
  prisma: { user: { findUnique: dbMock.findUnique } },
}));

await import('@/auth');
const { getSessionUser, requireSessionUser, requireAdmin } = await import('@/lib/auth');

type Callbacks = NonNullable<NextAuthConfig['callbacks']>;
type JwtParams = Parameters<NonNullable<Callbacks['jwt']>>[0];
type SessionParams = Parameters<NonNullable<Callbacks['session']>>[0];

function callbacks(): Callbacks {
  const config = nextAuthMock.config;
  if (!config || typeof config !== 'object' || !('callbacks' in config)) {
    throw new Error('auth.ts did not pass callbacks to NextAuth()');
  }
  const found = (config as { callbacks?: unknown }).callbacks;
  if (!found || typeof found !== 'object') throw new Error('auth.ts registered no callbacks');
  return found as Callbacks;
}

function jwtCallback(): NonNullable<Callbacks['jwt']> {
  const jwt = callbacks().jwt;
  if (typeof jwt !== 'function') throw new Error('auth.ts registered no jwt callback');
  return jwt;
}

function sessionCallback(): NonNullable<Callbacks['session']> {
  const session = callbacks().session;
  if (typeof session !== 'function') throw new Error('auth.ts registered no session callback');
  return session;
}

/** Seconds, as Auth.js stamps `iat`. */
const ISSUED_AT = Math.floor(Date.UTC(2026, 0, 2, 3, 4, 5) / 1000);

function storedToken(overrides: Partial<JWT> = {}): JWT {
  return {
    id: 'user-1',
    sub: 'user-1',
    role: 'MEMBER',
    isActive: true,
    name: 'Member',
    iat: ISSUED_AT,
    exp: ISSUED_AT + 14 * 24 * 60 * 60,
    ...overrides,
  };
}

/**
 * On a plain session read Auth.js calls the callback with a stored token and no
 * `user`; the published type marks `user` as required, so the shape is asserted
 * once here instead of at every call site.
 */
function sessionRead(token: JWT): JwtParams {
  return { token, account: null } as unknown as JwtParams;
}

function signIn(token: JWT, user: User): JwtParams {
  return { token, user, account: null, trigger: 'signIn' };
}

function sessionRefresh(session: Session, token: JWT): SessionParams {
  return { session, token } as unknown as SessionParams;
}

function browserSession(): Session {
  return {
    user: {
      id: 'stale-from-cookie',
      role: 'MEMBER',
      isActive: true,
      avatarUrl: null,
      name: 'Member',
      email: 'member@example.com',
    },
    expires: new Date(Date.now() + 60_000).toISOString(),
  };
}

const activeUser = {
  id: 'user-1',
  email: 'member@example.com',
  name: 'Member',
  role: 'MEMBER' as const,
  avatarUrl: null,
  isActive: true,
};

beforeEach(() => {
  nextAuthMock.auth.mockReset();
  dbMock.findUnique.mockReset();
  nextAuthMock.auth.mockResolvedValue({ user: { id: 'user-1' } });
});

describe('deactivated session', () => {
  it('resolves an active user', async () => {
    dbMock.findUnique.mockResolvedValue(activeUser);
    await expect(getSessionUser()).resolves.toMatchObject({ id: 'user-1', role: 'MEMBER' });
  });

  it('rejects a user who was deactivated after the token was issued', async () => {
    dbMock.findUnique.mockResolvedValue({ ...activeUser, isActive: false });
    await expect(getSessionUser()).resolves.toBeNull();
  });

  it('rejects a user row that no longer exists', async () => {
    dbMock.findUnique.mockResolvedValue(null);
    await expect(getSessionUser()).resolves.toBeNull();
  });

  it('returns 401 from requireSessionUser for a deactivated user', async () => {
    dbMock.findUnique.mockResolvedValue({ ...activeUser, isActive: false });
    await expect(requireSessionUser()).resolves.toEqual({
      user: null,
      error: 'Sign in required',
      status: 401,
    });
  });

  it('returns 401 from requireAdmin for a deactivated admin', async () => {
    dbMock.findUnique.mockResolvedValue({ ...activeUser, role: 'ADMIN', isActive: false });
    await expect(requireAdmin()).resolves.toEqual({
      user: null,
      error: 'Sign in required',
      status: 401,
    });
  });

  it('does not consult the database without a session id', async () => {
    nextAuthMock.auth.mockResolvedValue({ user: undefined });
    await expect(getSessionUser()).resolves.toBeNull();
    expect(dbMock.findUnique).not.toHaveBeenCalled();
  });
});

describe('token revocation in the jwt callback', () => {
  it('registers the callbacks this block drives', () => {
    // Without this the helpers would throw rather than assert, and a config
    // that stopped registering either callback would read as a crash of
    // unknown origin instead of a named failure.
    expect(nextAuthMock.calls).toBe(1);
    expect(typeof jwtCallback()).toBe('function');
    expect(typeof sessionCallback()).toBe('function');
  });

  it('drops the token identity for an inactive user', async () => {
    dbMock.findUnique.mockResolvedValue({ isActive: false, passwordChangedAt: null });
    const result = await jwtCallback()(sessionRead(storedToken()));

    expect(dbMock.findUnique).toHaveBeenCalledTimes(1);
    expect(dbMock.findUnique.mock.calls[0]?.[0]).toMatchObject({ where: { id: 'user-1' } });
    expect(result?.id).toBeUndefined();
    expect(result?.sub).toBeUndefined();
  });

  it('keeps the identity of an active user whose password has not changed', async () => {
    // The control for the case above: a callback that stripped every token
    // would satisfy it, and would sign everybody out.
    dbMock.findUnique.mockResolvedValue({ isActive: true, passwordChangedAt: null });
    const result = await jwtCallback()(sessionRead(storedToken()));

    expect(result?.id).toBe('user-1');
    expect(result?.sub).toBe('user-1');
    expect(result?.role).toBe('MEMBER');
  });

  it('drops the token identity for a user row that no longer exists', async () => {
    dbMock.findUnique.mockResolvedValue(null);
    const result = await jwtCallback()(sessionRead(storedToken()));
    expect(result?.id).toBeUndefined();
    expect(result?.sub).toBeUndefined();
  });

  it('drops the token identity for a session issued before a password change', async () => {
    dbMock.findUnique.mockResolvedValue({
      isActive: true,
      passwordChangedAt: new Date(ISSUED_AT * 1000 + 60_000),
    });
    const result = await jwtCallback()(sessionRead(storedToken()));
    expect(result?.id).toBeUndefined();
    expect(result?.sub).toBeUndefined();
  });

  it('keeps a session issued after the password change', async () => {
    dbMock.findUnique.mockResolvedValue({
      isActive: true,
      passwordChangedAt: new Date(ISSUED_AT * 1000 - 60_000),
    });
    const result = await jwtCallback()(sessionRead(storedToken()));
    expect(result?.id).toBe('user-1');
  });

  it('compares the password change to the issue time in milliseconds', async () => {
    // The comparison is `>`, so a change stamped at exactly the issued second
    // is not a revocation. One millisecond later is.
    dbMock.findUnique.mockResolvedValue({
      isActive: true,
      passwordChangedAt: new Date(ISSUED_AT * 1000),
    });
    expect((await jwtCallback()(sessionRead(storedToken())))?.id).toBe('user-1');

    dbMock.findUnique.mockResolvedValue({
      isActive: true,
      passwordChangedAt: new Date(ISSUED_AT * 1000 + 1),
    });
    expect((await jwtCallback()(sessionRead(storedToken())))?.id).toBeUndefined();
  });

  it('does not re-read the database on the sign-in call', async () => {
    // `authorize` has already checked the password and `isActive`; a query here
    // would be one extra round trip on every sign-in.
    const user: User = {
      id: 'user-2',
      email: 'fresh@example.com',
      name: 'Fresh',
      role: 'ADMIN' as Role,
      isActive: true,
      avatarUrl: null,
    };
    const result = await jwtCallback()(signIn({}, user));

    expect(dbMock.findUnique).not.toHaveBeenCalled();
    expect(result?.id).toBe('user-2');
    expect(result?.role).toBe('ADMIN');
  });

  it('keeps the token when the revocation query throws', async () => {
    // Documented, deliberate fail-open: a stale Prisma client before a server
    // restart must not sign the whole workspace out. It also means a database
    // outage suspends revocation, which is why `getSessionUser` re-reads
    // `isActive` on every request instead of trusting the token.
    dbMock.findUnique.mockRejectedValue(new Error('stale prisma client'));
    const result = await jwtCallback()(sessionRead(storedToken()));
    expect(result?.id).toBe('user-1');
  });

  it('skips the password check on a token with no iat', async () => {
    // Auth.js always stamps `iat`; this pins what happens if one arrives
    // without it — the inactive check still applies, the password-change check
    // cannot, because there is nothing to compare against.
    dbMock.findUnique.mockResolvedValue({
      isActive: true,
      passwordChangedAt: new Date(Date.now() + 60_000),
    });
    const noIat = storedToken();
    delete noIat.iat;
    expect((await jwtCallback()(sessionRead(noIat)))?.id).toBe('user-1');

    dbMock.findUnique.mockResolvedValue({ isActive: false, passwordChangedAt: null });
    const noIatInactive = storedToken();
    delete noIatInactive.iat;
    expect((await jwtCallback()(sessionRead(noIatInactive)))?.id).toBeUndefined();
  });

  it('leaves the session without a user once the identity is stripped', async () => {
    dbMock.findUnique.mockResolvedValue({ isActive: false, passwordChangedAt: null });
    const stripped = await jwtCallback()(sessionRead(storedToken()));
    expect(stripped).not.toBeNull();
    if (!stripped) throw new Error('the jwt callback returned no token');

    const session = await sessionCallback()(sessionRefresh(browserSession(), stripped));
    // The cookie still carried a user object. The session callback must not
    // hand it back, or `auth()` would report a revoked user as signed in.
    expect(session.user).toBeUndefined();
  });

  it('still fills the session in for a token that survived', async () => {
    dbMock.findUnique.mockResolvedValue({ isActive: true, passwordChangedAt: null });
    const kept = await jwtCallback()(sessionRead(storedToken({ role: 'ADMIN' })));
    if (!kept) throw new Error('the jwt callback returned no token');

    const session = await sessionCallback()(sessionRefresh(browserSession(), kept));
    expect(session.user?.id).toBe('user-1');
    expect(session.user?.role).toBe('ADMIN');
  });
});

describe('getSessionUser does not trust the token', () => {
  it('reads isActive from the database even when the session says active', async () => {
    // The session object here claims an active user, exactly as a cookie
    // written before deactivation would. Only the row decides.
    nextAuthMock.auth.mockResolvedValue({
      user: { id: 'user-1', role: 'ADMIN', isActive: true, name: 'Member' },
    });
    dbMock.findUnique.mockResolvedValue({ ...activeUser, role: 'ADMIN', isActive: false });

    await expect(getSessionUser()).resolves.toBeNull();
    expect(dbMock.findUnique).toHaveBeenCalledTimes(1);
  });

  it('takes the role from the database, not from the session', async () => {
    // A token minted while the user was ADMIN must not keep admin rights after
    // a demotion.
    nextAuthMock.auth.mockResolvedValue({
      user: { id: 'user-1', role: 'ADMIN', isActive: true, name: 'Member' },
    });
    dbMock.findUnique.mockResolvedValue({ ...activeUser, role: 'MEMBER' });

    await expect(getSessionUser()).resolves.toMatchObject({ role: 'MEMBER' });
    await expect(requireAdmin()).resolves.toMatchObject({ status: 403 });
  });
});
