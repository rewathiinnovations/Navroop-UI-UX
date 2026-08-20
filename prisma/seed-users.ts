/**
 * User seeding for `prisma/seed.ts`, exported separately so the guards are
 * testable without executing the whole seed (which runs on import).
 *
 * The demo-member credential itself lives in `lib/ensure-member.ts` — the
 * single source (F-795); this module must not restate it.
 */
import bcrypt from 'bcryptjs';
import type { PrismaClient } from '../generated/prisma/index.js';
import { DEMO_MEMBER_EMAIL, DEMO_MEMBER_PASSWORD } from '../lib/ensure-member';

export function seedAdminCredentials(env: NodeJS.ProcessEnv = process.env) {
  const email = String(env.SEED_ADMIN_EMAIL || env.ADMIN_EMAIL || '')
    .trim()
    .toLowerCase();
  const password = String(env.SEED_ADMIN_PASSWORD || env.ADMIN_PASSWORD || '');
  return { email, password };
}

export async function ensureAdmin(prisma: PrismaClient, env: NodeJS.ProcessEnv = process.env) {
  const { email, password } = seedAdminCredentials(env);
  if (!email || password.length < 8) {
    console.warn(
      'Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD (or ADMIN_EMAIL / ADMIN_PASSWORD) to seed the first admin.',
    );
    return;
  }

  const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
  if (admin) {
    console.log('Admin already exists.');
    return;
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    await prisma.user.update({ where: { id: existing.id }, data: { role: 'ADMIN' } });
    console.log('Promoted existing user to ADMIN.');
    return;
  }

  await prisma.user.create({
    data: {
      email,
      name: 'Admin',
      passwordHash: await bcrypt.hash(password, 12),
      role: 'ADMIN',
    },
  });
  console.log('Created first admin from SEED_ADMIN_EMAIL / ADMIN_EMAIL.');
}

/**
 * The demo member's password is a committed literal, so the row must never
 * appear in a production database by default (F-301). Members come from an
 * admin invite there; an operator who really wants the demo fixture says so
 * explicitly with SEED_DEMO_MEMBER=1 (runtime env for the seed process only).
 */
export function demoMemberAllowed(env: NodeJS.ProcessEnv = process.env) {
  if (env.SEED_DEMO_MEMBER === '1') return true;
  return env.NODE_ENV !== 'production';
}

export async function ensureMember(prisma: PrismaClient, env: NodeJS.ProcessEnv = process.env) {
  if (!demoMemberAllowed(env)) {
    console.log('Skipped demo member: NODE_ENV is production and SEED_DEMO_MEMBER=1 is not set.');
    return;
  }

  const existing = await prisma.user.findUnique({ where: { email: DEMO_MEMBER_EMAIL } });
  if (existing) {
    console.log('Demo member already exists.');
    return;
  }

  await prisma.user.create({
    data: {
      email: DEMO_MEMBER_EMAIL,
      name: 'Member',
      passwordHash: await bcrypt.hash(DEMO_MEMBER_PASSWORD, 12),
      role: 'MEMBER',
    },
  });
  console.log('Created demo member.');
}
