/**
 * Project full-text search matches original prompt text.
 * Run: pnpm exec tsx tests/search.test.ts
 */
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { testPrismaClient } from './setup/db.ts';
import { hashPassword } from '../lib/password.ts';
import { searchProjects } from '../lib/search/projects.ts';

config({ path: resolve(process.cwd(), '.env.local') });
config({ path: resolve(process.cwd(), '.env') });

const prisma = testPrismaClient();

let failed = 0;
let passed = 0;

function assert(cond: unknown, name: string) {
  if (cond) {
    passed += 1;
    console.log(`PASS  ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL  ${name}`);
}

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
const owner = await prisma.user.create({
  data: {
    email: `search-owner-${suffix}@example.com`,
    name: 'Search Owner',
    passwordHash: await hashPassword('SearchPass123'),
    role: 'MEMBER',
  },
});

const live = await prisma.project.create({
  data: {
    name: 'Sharma Catering',
    initialPrompt:
      'Build a website for a neighbourhood restaurant in Pune that serves thali lunches and weekend tasting menus.',
    ownerId: owner.id,
    status: 'draft',
  },
});

const deleted = await prisma.project.create({
  data: {
    name: 'Hidden Kitchen',
    initialPrompt: 'Another restaurant brief that should not appear after soft delete.',
    ownerId: owner.id,
    status: 'draft',
    deletedAt: new Date(),
  },
});

try {
  const hits = await searchProjects({ q: 'restaurant', limit: 20 });
  assert(
    hits.some((row) => row.id === live.id),
    'searching restaurant finds a project whose name is a client name',
  );
  const match = hits.find((row) => row.id === live.id);
  assert(Boolean(match?.snippet && /restaurant/i.test(match.snippet)), 'result includes a matched snippet');
  assert(!hits.some((row) => row.id === deleted.id), 'soft-deleted projects are excluded');
  assert(hits.length <= 20, 'search is limited to 20');
} finally {
  await prisma.project.deleteMany({ where: { id: { in: [live.id, deleted.id] } } });
  await prisma.user.delete({ where: { id: owner.id } });
  await prisma.$disconnect();
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
