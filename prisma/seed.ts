/**
 * The one seed entry point, run by `pnpm db:seed` and Prisma's `seed` hook via
 * tsx. The former `prisma/seed.mjs` copy was deleted (F-301/F-795): the two
 * files had already drifted, and only one ever ran.
 */
import { PrismaClient } from '../generated/prisma/index.js';
import { seedTemplates } from './seed-templates.ts';
import { ensureAdmin, ensureMember } from './seed-users';

const prisma = new PrismaClient();

const MB = 1024 * 1024;
const GB = 1024 * MB;

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
  await ensureAdmin(prisma);
  await ensureMember(prisma);
  await ensurePlans();
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
