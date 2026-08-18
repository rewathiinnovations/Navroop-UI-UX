/**
 * Seeds the single account the authenticated Playwright journey signs in as.
 *
 * Navroop is invite-only, so registration is not a path: the row is written
 * straight through Prisma. The hash comes from `lib/password.hashPassword` — the
 * same function `auth.ts` verifies against — so this cannot drift from the real
 * credentials provider.
 */
// Explicit `index.js`: Playwright's ESM loader does not resolve a relative
// directory import, and the generated client's `exports` map only applies to
// package-name imports.
import { PrismaClient } from '../../generated/prisma/index.js';
import { TERMS_VERSION } from '../../lib/legal/terms';
import { hashPassword } from '../../lib/password';
import { loadPlaywrightDotenv } from '../../lib/verify/playwright-env';
import { resolveE2eTarget, type E2eAccount } from './account';

export type SeedResult = {
  account: E2eAccount;
  database: string;
  created: boolean;
};

/**
 * Idempotent: one `upsert` keyed on the unique email. A second run rewrites the
 * hash (bcrypt salts every call, so the value differs and both verify) and puts
 * the row back into a signed-in-able state — active, MEMBER, terms accepted — in
 * case an earlier test or an admin screen changed it.
 *
 * `passwordChangedAt` is deliberately left alone: `auth.ts` rejects any JWT
 * issued before it, so stamping it here would invalidate a storage state that is
 * still perfectly good.
 */
export async function seedE2eAccount(): Promise<SeedResult> {
  loadPlaywrightDotenv();

  const resolved = resolveE2eTarget(process.env);
  if (!resolved.ok) {
    throw new Error(resolved.error);
  }
  const { databaseUrl, database, account } = resolved.target;

  const prisma = new PrismaClient({ datasourceUrl: databaseUrl, log: ['error'] });
  try {
    const before = await prisma.user.findUnique({
      where: { email: account.email },
      select: { id: true },
    });
    const passwordHash = await hashPassword(account.password);
    const acceptedAt = new Date();

    await prisma.user.upsert({
      where: { email: account.email },
      update: {
        name: account.name,
        passwordHash,
        role: 'MEMBER',
        isActive: true,
        termsAcceptedAt: acceptedAt,
        termsVersion: TERMS_VERSION,
      },
      create: {
        email: account.email,
        name: account.name,
        passwordHash,
        role: 'MEMBER',
        isActive: true,
        termsAcceptedAt: acceptedAt,
        termsVersion: TERMS_VERSION,
      },
    });

    return { account, database, created: before === null };
  } finally {
    await prisma.$disconnect();
  }
}
