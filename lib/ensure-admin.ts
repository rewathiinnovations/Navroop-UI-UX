import { prisma } from '@/lib/db';
import { getSeedAdminCredentials, hashPassword, validateEmail } from '@/lib/password';

export async function ensureAdminUser() {
  const existingAdmin = await prisma.user.findFirst({
    where: { role: 'ADMIN' },
    select: { id: true },
  });
  if (existingAdmin) return { created: false as const };

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

  return { created: true as const };
}
