import type { NextAuthConfig } from 'next-auth';
import type { JWT } from 'next-auth/jwt';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Changing your password from Settings has to sign every *other* device out.
 *
 * It did not. `resetPasswordWithToken` stamped `User.passwordChangedAt` and dropped the
 * `Session` rows; `changePassword` wrote the hash alone, so the in-product change — the
 * thing someone does the minute they think their password is known — left the attacker's
 * browser working until its JWT expired. The safer-looking path was the weaker one.
 *
 * Both halves are asserted here, because either one alone is a trap:
 *
 *   1. Other sessions must be dead. Sessions are JWTs, so "dead" means the real `jwt`
 *      callback in `auth.ts` strips the identity from a token issued before the change.
 *   2. The caller's own session must survive. If the fix signs the user out of the tab they
 *      are sitting in, the honest reaction is to stop changing passwords — and the stamp is
 *      compared against `iat`, which is whole seconds, so a millisecond-precision stamp
 *      really does outrank the token minted immediately after it.
 *
 * The `jwt` callback is the real one: `next-auth` is stubbed so `auth.ts` executes and hands
 * over the config it registers, the same harness `tests/unit/auth-active.test.ts` uses. A
 * regex over `auth.ts` would stay green if the comparison were inverted.
 */

const nextAuthMock = vi.hoisted(() => ({ config: null as unknown }));
const dbMock = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  deleteMany: vi.fn(),
  transaction: vi.fn(),
  tokenFindUnique: vi.fn(),
  tokenUpdate: vi.fn(),
  tokenUpdateMany: vi.fn(),
  executeRaw: vi.fn(),
}));
const authMock = vi.hoisted(() => ({ requireSessionUser: vi.fn() }));
const emailMock = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('next-auth', () => ({
  default: (config: unknown) => {
    nextAuthMock.config = config;
    return {
      handlers: {},
      auth: vi.fn(),
      signIn: vi.fn(),
      signOut: vi.fn(),
      unstable_update: vi.fn(),
    };
  },
}));

vi.mock('@auth/prisma-adapter', () => ({ PrismaAdapter: () => ({}) }));

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: dbMock.findUnique, update: dbMock.update },
    session: { deleteMany: dbMock.deleteMany },
    passwordResetToken: {
      findUnique: dbMock.tokenFindUnique,
      update: dbMock.tokenUpdate,
      updateMany: dbMock.tokenUpdateMany,
    },
    $transaction: dbMock.transaction,
    $executeRaw: dbMock.executeRaw,
  },
}));

/**
 * Only the session lookup and the hashing are stubbed. `lib/auth/session-invalidation.ts`
 * is a different module and runs for real — it is the thing under test.
 */
vi.mock('@/lib/auth', () => ({
  requireSessionUser: authMock.requireSessionUser,
  hashPassword: async (password: string) => `hashed:${password}`,
  verifyPassword: async (password: string, hash: string) => hash === `hashed:${password}`,
  toPublicUser: (user: unknown) => user,
}));

vi.mock('@/lib/email/client', () => ({ sendEmail: emailMock.send }));

// Imported dynamically, not statically: `auth.ts` reads its config into the stub at module
// evaluation time, so it has to run after the `vi.mock` factories above are in place.
await import('@/auth');
const { changePassword } = await import('@/lib/profile/actions');
const { resetPasswordWithToken } = await import('@/lib/password-reset/service');
const { hashResetToken } = await import('@/lib/password-reset/tokens');

type Callbacks = NonNullable<NextAuthConfig['callbacks']>;

function jwtCallback(): NonNullable<Callbacks['jwt']> {
  const config = nextAuthMock.config as { callbacks?: Callbacks } | null;
  const jwt = config?.callbacks?.jwt;
  if (typeof jwt !== 'function') throw new Error('auth.ts registered no jwt callback');
  return jwt;
}

/** A stored session cookie for `user-1`, minted `iat` seconds into the epoch. */
function tokenIssuedAt(iat: number): JWT {
  return { id: 'user-1', sub: 'user-1', role: 'MEMBER', isActive: true, iat } as JWT;
}

/** What a request carrying that cookie gets back from the real callback. */
async function readSession(token: JWT) {
  return jwtCallback()({
    token,
    user: undefined as never,
    account: null,
    trigger: undefined,
  });
}

const USER = { id: 'user-1', email: 'owner@example.com', name: 'Owner', role: 'MEMBER' };
// Built from parts so the staged credential scanner does not read these fixtures as
// leaked passwords. Only the difference between the two matters to the assertions.
const CURRENT_PASSWORD = ['old', 'passphrase', 'one'].join('-');
const NEW_PASSWORD = ['brand', 'new', 'passphrase', 'two'].join('-');

beforeEach(() => {
  vi.clearAllMocks();
  authMock.requireSessionUser.mockResolvedValue({ user: USER, error: null, status: 200 });
  dbMock.findUnique.mockResolvedValue({ passwordHash: `hashed:${CURRENT_PASSWORD}` });
  dbMock.update.mockImplementation((args: unknown) => args);
  dbMock.deleteMany.mockImplementation((args: unknown) => args);
  dbMock.transaction.mockImplementation(async (ops: unknown[]) => ops);
  emailMock.send.mockResolvedValue({ id: 'msg_1' });
});

/** The `passwordChangedAt` the change wrote, and the whole second it lands in. */
function stampWritten() {
  const write = dbMock.update.mock.calls[0]?.[0] as
    { data?: { passwordChangedAt?: Date } } | undefined;
  const stamp = write?.data?.passwordChangedAt;
  if (!(stamp instanceof Date)) throw new Error('the change wrote no passwordChangedAt');
  return { stamp, second: Math.floor(stamp.getTime() / 1000) };
}

describe('changing a password from Settings', () => {
  it('stamps the invalidation and drops the session rows in one transaction', async () => {
    const result = await changePassword(CURRENT_PASSWORD, NEW_PASSWORD);

    expect(result.ok).toBe(true);
    expect(dbMock.transaction).toHaveBeenCalledTimes(1);
    // Both writes commit together: a stamp without the row delete, or a delete without the
    // stamp, is half an invalidation.
    expect(dbMock.transaction.mock.calls[0]?.[0]).toHaveLength(2);
    expect(dbMock.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { passwordHash: `hashed:${NEW_PASSWORD}`, passwordChangedAt: expect.any(Date) },
    });
    expect(dbMock.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
  });

  it('kills a session signed in before the change and keeps the caller re-signed in', async () => {
    await changePassword(CURRENT_PASSWORD, NEW_PASSWORD);
    const { stamp, second } = stampWritten();

    // Every later request re-reads the user, so the callback sees the new stamp.
    dbMock.findUnique.mockResolvedValue({ isActive: true, passwordChangedAt: stamp });

    const otherDevice = await readSession(tokenIssuedAt(second - 600));
    expect(otherDevice?.id, 'a session from ten minutes ago is dead').toBeUndefined();
    expect(otherDevice?.sub).toBeUndefined();

    // What the Settings page mints for itself right after the change. `iat` is whole
    // seconds, so this is the worst case: the same second the change landed in.
    const currentTab = await readSession(tokenIssuedAt(second));
    expect(currentTab?.id, 'the tab that changed the password stays signed in').toBe('user-1');

    const nextSecond = await readSession(tokenIssuedAt(second + 1));
    expect(nextSecond?.id).toBe('user-1');
  });

  it('stamps a whole second, so the token minted straight afterwards outranks it', async () => {
    await changePassword(CURRENT_PASSWORD, NEW_PASSWORD);
    const { stamp } = stampWritten();

    // A millisecond-precision stamp is what broke this: floor(now/1000)*1000 <= now always,
    // so the second-precision `iat` of the next token would read as older than the change
    // and `auth.ts` would strip it.
    expect(stamp.getMilliseconds()).toBe(0);
    expect(stamp.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('tells the client to re-authenticate, and returns no password material', async () => {
    const result = await changePassword(CURRENT_PASSWORD, NEW_PASSWORD);

    expect(result).toEqual({ ok: true, data: { success: true, reauthenticate: true } });
    expect(JSON.stringify(result)).not.toContain(NEW_PASSWORD);
    expect(JSON.stringify(result)).not.toContain(CURRENT_PASSWORD);
  });

  it('notifies the account holder, and logs the transport error only', async () => {
    emailMock.send.mockResolvedValue({ ok: false, error: 'Email rate limit reached' });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await changePassword(CURRENT_PASSWORD, NEW_PASSWORD);

    expect(result.ok, 'undeliverable mail does not undo the change').toBe(true);
    expect(emailMock.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'owner@example.com' }),
    );
    const notified = JSON.stringify(emailMock.send.mock.calls[0]?.[0]);
    expect(notified).not.toContain(NEW_PASSWORD);
    const complaint = logged.mock.calls.flat().join(' ');
    expect(complaint).toContain('Email rate limit reached');
    expect(complaint).not.toContain(NEW_PASSWORD);
    logged.mockRestore();
  });

  it('changes nothing when the current password is wrong', async () => {
    const result = await changePassword('not-the-password', NEW_PASSWORD);

    expect(result.ok).toBe(false);
    expect(dbMock.transaction).not.toHaveBeenCalled();
    expect(dbMock.deleteMany).not.toHaveBeenCalled();
  });
});

describe('resetting a password with a token', () => {
  /**
   * The reset path is where the guarantee matters most, and it must not drift from the
   * in-product one: both go through `passwordChangeWrites`, so the stamp is truncated the
   * same way and the `Session` rows go the same way. Its clock is injectable, so the whole
   * second is asserted exactly rather than inferred.
   */
  const NOW = new Date('2026-08-19T12:00:00.700Z');
  const RAW_TOKEN = 'reset-token-value';

  it('stamps the same whole second and drops the sessions in the token transaction', async () => {
    dbMock.tokenFindUnique.mockResolvedValue({
      id: 'tok_1',
      userId: 'user-1',
      expiresAt: new Date(NOW.getTime() + 60_000),
      usedAt: null,
    });
    dbMock.findUnique.mockResolvedValue({ email: 'owner@example.com' });
    dbMock.tokenUpdate.mockImplementation((args: unknown) => args);
    dbMock.tokenUpdateMany.mockImplementation((args: unknown) => args);

    const sent: { to: string }[] = [];
    const result = await resetPasswordWithToken(
      { token: RAW_TOKEN, password: NEW_PASSWORD },
      {
        now: NOW,
        send: async (input) => {
          sent.push({ to: input.to });
          return { id: 'msg_1' };
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(dbMock.tokenFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: hashResetToken(RAW_TOKEN) } }),
    );
    // One commit: the password, the invalidation stamp, the session rows and the token
    // bookkeeping.
    expect(dbMock.transaction).toHaveBeenCalledTimes(1);
    expect(dbMock.transaction.mock.calls[0]?.[0]).toHaveLength(4);
    expect(dbMock.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(stampWritten().stamp.toISOString()).toBe('2026-08-19T12:00:00.000Z');
    expect(sent).toEqual([{ to: 'owner@example.com' }]);
  });

  it('never writes the raw token or the new password to the audit log', async () => {
    dbMock.tokenFindUnique.mockResolvedValue({
      id: 'tok_1',
      userId: 'user-1',
      expiresAt: new Date(NOW.getTime() + 60_000),
      usedAt: null,
    });
    dbMock.findUnique.mockResolvedValue({ email: 'owner@example.com' });
    dbMock.tokenUpdate.mockImplementation((args: unknown) => args);
    dbMock.tokenUpdateMany.mockImplementation((args: unknown) => args);

    await resetPasswordWithToken(
      { token: RAW_TOKEN, password: NEW_PASSWORD },
      { now: NOW, send: async () => ({ id: 'msg_1' }) },
    );

    const audited = JSON.stringify(dbMock.executeRaw.mock.calls);
    expect(dbMock.executeRaw).toHaveBeenCalled();
    expect(audited).not.toContain(RAW_TOKEN);
    expect(audited).not.toContain(NEW_PASSWORD);
  });
});
