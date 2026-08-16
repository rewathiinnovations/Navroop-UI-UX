import { PrismaClient } from '../generated/prisma/index.js';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const DEMO_MEMBER_EMAIL = 'member@navroop.local';
const DEMO_MEMBER_PASSWORD = 'ChangeMeNow123';

function seedAdminCredentials() {
  const email = String(process.env.SEED_ADMIN_EMAIL || process.env.ADMIN_EMAIL || '')
    .trim()
    .toLowerCase();
  const password = String(process.env.SEED_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || '');
  return { email, password };
}

async function ensureAdmin() {
  const { email, password } = seedAdminCredentials();
  if (!email || password.length < 8) {
    console.warn('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD (or ADMIN_EMAIL / ADMIN_PASSWORD) to seed the first admin.');
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

async function ensureMember() {
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

async function main() {
  await ensureAdmin();
  await ensureMember();
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
