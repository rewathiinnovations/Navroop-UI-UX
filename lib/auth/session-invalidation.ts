import type { Prisma } from '@/generated/prisma';
import { prisma } from '@/lib/db';

/**
 * The write pair that makes a new password sign every *other* browser out.
 *
 * Both password paths have to do exactly the same two things, and until now only one of
 * them did: `resetPasswordWithToken` stamped `passwordChangedAt` and dropped `Session`
 * rows, while `changePassword` (Settings → Password) wrote the hash alone. So the
 * in-product change — the thing someone does the moment they believe their account is
 * compromised — left every already-signed-in device, including the attacker's, working
 * until its JWT expired. The mechanism lives here so the two callers cannot drift again.
 *
 *  1. `User.passwordChangedAt` is the real gate. Sessions are JWTs (`auth.ts`,
 *     `session.strategy = 'jwt'`), so there is no server-side record to delete; the `jwt`
 *     callback strips the identity from any token whose `iat` predates this stamp.
 *  2. `Session` rows are the PrismaAdapter table. It is empty under the JWT strategy, but
 *     a row left behind by an earlier strategy must not outlive the password either.
 *
 * The stamp is truncated to a whole second because `iat` is whole seconds. A millisecond
 * stamp is *newer* than the second-precision token minted right after it, so the person who
 * just changed their own password would be signed out of the tab they are sitting in.
 * `auth.ts` compares with `>` (equality survives — pinned in tests/unit/auth-active.test.ts),
 * so flooring keeps the caller's fresh token valid. The cost is a ≤1s window in which a
 * token minted in the same second as the change also survives; that beats logging the
 * caller out of their own password change, and any such token dies at the next password
 * change anyway.
 *
 * Returns Prisma promises rather than awaiting them so each caller can put them in its own
 * `$transaction` — the reset path commits them together with the token bookkeeping. That
 * path needs to branch on a claim first, so it runs an interactive transaction and passes
 * its `tx` in; the statements have to be built on the same client that owns the
 * transaction or they would commit outside it (F-745).
 */
export function passwordChangeWrites(
  userId: string,
  passwordHash: string,
  now: Date,
  client: Prisma.TransactionClient = prisma,
) {
  const passwordChangedAt = new Date(Math.floor(now.getTime() / 1000) * 1000);
  return [
    client.user.update({ where: { id: userId }, data: { passwordHash, passwordChangedAt } }),
    client.session.deleteMany({ where: { userId } }),
  ];
}
