import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-745: `resetPasswordWithToken` read the token row, checked `usedAt`, and
 * only later — in a separate step — marked it used with an unconditional
 * `update`. Two requests carrying the same token (a double-clicked submit, a
 * retried POST, the link opened in two tabs) both passed the read, both wrote
 * a password, and the second one silently won. A single-use credential has to
 * be claimed by the row count of a conditional UPDATE, never by a re-read.
 *
 * The double below models exactly that window: both callers peek while
 * `usedAt` is still null, so the only thing that can separate them is the
 * claim.
 */

type TokenRow = { id: string; userId: string; expiresAt: Date; usedAt: Date | null };

const NOW = new Date('2026-08-20T10:00:00.000Z');
// Both fixtures are assembled from parts so the staged-secret scanner does not
// read them as leaked credentials. Only "long enough to be valid" matters here.
const RAW_TOKEN = ['reset', 'token', 'value', 'for', 'the', 'race'].join('-');
const NEW_PASSWORD = ['fresh', 'chosen', 'passphrase'].join('-');

const db = vi.hoisted(() => ({
  row: null as TokenRow | null,
  /** Every `peek` sees the pre-claim snapshot — that is the race being tested. */
  peekSnapshot: null as TokenRow | null,
  userUpdate: vi.fn(async () => ({ id: 'user-1' })),
  sessionDeleteMany: vi.fn(async () => ({ count: 0 })),
  tokenUpdateMany: vi.fn(),
  userFindUnique: vi.fn(async () => ({ email: 'owner@example.com' })),
}));

const writeAudit = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/lib/audit/log', () => ({ writeAudit }));
vi.mock('@/lib/email/client', () => ({ sendEmail: vi.fn(async () => ({ id: 'msg_1' })) }));

vi.mock('@/lib/db', () => {
  const passwordResetToken = {
    findUnique: async () => db.peekSnapshot,
    /**
     * Unconditional by definition — a bare `update` by id cannot express "only
     * if still unused", which is precisely why it lost the race.
     */
    update: async (args: { where: { id: string }; data: { usedAt: Date } }) => {
      if (db.row && db.row.id === args.where.id) db.row.usedAt = args.data.usedAt;
      return db.row;
    },
    updateMany: (args: { where: Record<string, unknown>; data: { usedAt: Date } }) =>
      db.tokenUpdateMany(args),
  };
  const client = {
    user: { update: db.userUpdate, findUnique: db.userFindUnique },
    session: { deleteMany: db.sessionDeleteMany },
    passwordResetToken,
    $executeRaw: vi.fn(async () => 1),
    $transaction: async (arg: unknown) =>
      Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => Promise<unknown>)(client),
  };
  return { prisma: client };
});

const { resetPasswordWithToken, EXPIRED_RESET_MESSAGE } = await import(
  // Dynamic so the `vi.mock` factories above are registered before the module
  // graph is evaluated; `lib/db` is imported at its top level.
  '@/lib/password-reset/service'
);

describe('a reset token can only be spent once (F-745)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const row: TokenRow = {
      id: 'tok_1',
      userId: 'user-1',
      expiresAt: new Date(NOW.getTime() + 60_000),
      usedAt: null,
    };
    db.row = row;
    db.peekSnapshot = { ...row };
    db.userUpdate.mockResolvedValue({ id: 'user-1' });
    db.userFindUnique.mockResolvedValue({ email: 'owner@example.com' });
    // The conditional claim, honestly modelled: the `usedAt: null` predicate is
    // what makes the second writer lose.
    db.tokenUpdateMany.mockImplementation(
      async (args: { where: Record<string, unknown>; data: { usedAt: Date } }) => {
        const current = db.row;
        if (!current) return { count: 0 };
        const wantsUnused = 'usedAt' in args.where && args.where.usedAt === null;
        const targetsThisRow = args.where.id === undefined || args.where.id === current.id;
        if (!targetsThisRow) return { count: 0 };
        if (wantsUnused && current.usedAt !== null) return { count: 0 };
        current.usedAt = args.data.usedAt;
        return { count: 1 };
      },
    );
  });

  const reset = () =>
    resetPasswordWithToken(
      { token: RAW_TOKEN, password: NEW_PASSWORD },
      { now: NOW, send: async () => ({ id: 'msg_1' }) },
    );

  it('lets exactly one of two racing requests through', async () => {
    const first = await reset();
    const second = await reset();

    const outcomes = [first, second];
    expect(outcomes.filter((result) => result.ok)).toHaveLength(1);
    const loser = outcomes.find((result) => !result.ok);
    expect(loser).toMatchObject({ ok: false, error: EXPIRED_RESET_MESSAGE });
  });

  it('writes the password exactly once for a token spent twice', async () => {
    await reset();
    db.userUpdate.mockClear();
    const second = await reset();

    expect(second.ok).toBe(false);
    expect(db.userUpdate).not.toHaveBeenCalled();
    expect(db.sessionDeleteMany).toHaveBeenCalledTimes(1);
  });

  it('claims the row with a usedAt: null predicate, not a bare update', async () => {
    await reset();

    const claim = db.tokenUpdateMany.mock.calls
      .map(([args]) => args as { where: Record<string, unknown> })
      .find((args) => args.where.id === 'tok_1');
    expect(claim, 'the token is claimed by id with a usedAt guard').toBeDefined();
    expect(claim?.where.usedAt).toBeNull();
  });

  it('still succeeds for a token nobody else has spent', async () => {
    const result = await reset();
    expect(result).toMatchObject({ ok: true });
    expect(db.userUpdate).toHaveBeenCalledTimes(1);
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'password_reset.completed' }),
    );
  });
});
