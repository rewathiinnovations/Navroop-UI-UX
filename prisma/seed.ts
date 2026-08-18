import { PrismaClient } from '../generated/prisma/index.js';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const DEMO_MEMBER_EMAIL = 'member@navroop.local';
const DEMO_MEMBER_PASSWORD = 'ChangeMeNow123';
const MB = 1024 * 1024;
const GB = 1024 * MB;

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

async function ensurePlans() {
  await prisma.plan.upsert({
    where: { key: 'free' },
    create: {
      key: 'free',
      name: 'Free',
      isActive: true,
      isDefault: true,
      monthlyCredits: 100,
      maxProjects: 5,
      maxLiveSites: 1,
      maxPreviewSites: 3,
      maxMembers: 2,
      maxConcurrentSandboxes: 1,
      checkpointRetentionDays: 7,
      storageBytesLimit: BigInt(500 * MB),
      allowCustomDomain: false,
      allowGithubSync: false,
    },
    update: {},
  });

  await prisma.plan.upsert({
    where: { key: 'pro' },
    create: {
      key: 'pro',
      name: 'Pro',
      isActive: false,
      isDefault: false,
      monthlyCredits: 2000,
      maxProjects: -1,
      maxLiveSites: 20,
      maxPreviewSites: -1,
      maxMembers: 15,
      maxConcurrentSandboxes: 5,
      checkpointRetentionDays: 90,
      storageBytesLimit: BigInt(20 * GB),
      allowCustomDomain: true,
      allowGithubSync: true,
    },
    update: {},
  });

  await prisma.workspace.upsert({
    where: { id: 'default' },
    create: { id: 'default', storageBytes: 0 },
    update: {},
  });

  console.log('Seeded Free (default) and inactive Pro plans.');
}

async function main() {
  await ensureAdmin();
  await ensureMember();
  await ensurePlans();
  const { seedTemplates } = await import('./seed-templates.ts');
  await seedTemplates(prisma);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
