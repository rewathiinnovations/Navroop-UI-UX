import { prisma } from '@/lib/db';
import { getSeedAdminCredentials, hashPassword, validateEmail } from '@/lib/password';

/**
 * "An admin exists" is a one-way answer: nothing in the product deletes the last
 * admin (the last-admin database trigger forbids it), so once it is true it stays
 * true for the life of the process.
 *
 * Memoising it matters because `ensureAdminUser` sits on public endpoints
 * (`POST /api/auth/login`, `GET /api/auth/me`). Unmemoised, every unauthenticated
 * request drove a `user.findFirst` — a database query per request from an
 * unauthenticated caller, which is exactly what the login throttle exists to
 * bound (F-321). The `false` answer is never cached, so a deployment that has not
 * been seeded yet still gets its chance on the next call.
 */
let adminSeeded = false;

/** Test seam: the memo is process-wide, so a suite has to be able to clear it. */
export function resetAdminSeedMemo() {
  adminSeeded = false;
}

export async function ensureAdminUser() {
  if (adminSeeded) return { created: false as const, memoised: true as const };

  const existingAdmin = await prisma.user.findFirst({
    where: { role: 'ADMIN' },
    select: { id: true },
  });
  if (existingAdmin) {
    adminSeeded = true;
    return { created: false as const };
  }

  const { email, password } = getSeedAdminCredentials();
  if (!validateEmail(email) || password.length < 8) {
    console.warn(
      '[ensure-admin] Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD (or ADMIN_EMAIL / ADMIN_PASSWORD, min 8 chars) to seed the first admin.',
    );
    return { created: false as const };
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    await prisma.user.update({
      where: { id: existing.id },
      data: { role: 'ADMIN' },
    });
    adminSeeded = true;
    return { created: false as const, promoted: true as const };
  }

  await prisma.user.create({
    data: {
      email,
      name: 'Admin',
      passwordHash: await hashPassword(password),
      role: 'ADMIN',
    },
  });

  adminSeeded = true;
  return { created: true as const };
}
