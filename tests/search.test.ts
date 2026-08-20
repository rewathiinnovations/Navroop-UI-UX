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

/**
 * The query term is a nonce, not the word "restaurant".
 *
 * F-607: `searchProjects({ q: 'restaurant', limit: 20 })` is unscoped by owner and
 * capped at 20 rows, so twenty higher-ranked "restaurant" projects left in the shared
 * `openlovable_test` database by another suite (or a previous crashed run) pushed the
 * seeded row off the page and failed this suite for a reason that has nothing to do
 * with search. A term no other row can contain makes the result set exactly ours, so
 * the hit count itself becomes assertable.
 */
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const TERM = `restaurantnonce${suffix}`;

let owner: { id: string } | null = null;
let live: { id: string } | null = null;
let deleted: { id: string } | null = null;

try {
  // Inside the try: a throw in the third create used to leak the first two rows.
  owner = await prisma.user.create({
    data: {
      email: `search-owner-${suffix}@example.com`,
      name: 'Search Owner',
      passwordHash: await hashPassword('SearchPass123'),
      role: 'MEMBER',
    },
  });

  live = await prisma.project.create({
    data: {
      name: 'Sharma Catering',
      initialPrompt: `Build a website for a neighbourhood ${TERM} in Pune that serves thali lunches and weekend tasting menus.`,
      ownerId: owner.id,
      status: 'draft',
    },
  });

  deleted = await prisma.project.create({
    data: {
      name: 'Hidden Kitchen',
      initialPrompt: `Another ${TERM} brief that should not appear after soft delete.`,
      ownerId: owner.id,
      status: 'draft',
      deletedAt: new Date(),
    },
  });

  const hits = await searchProjects({ q: TERM, limit: 20 });
  assert(hits.length === 1, 'only the seeded live project matches the nonce term');
  assert(
    hits[0]?.id === live.id,
    'searching the prompt text finds a project whose name is a client name',
  );
  const match = hits.find((row) => row.id === live.id);
  assert(
    Boolean(match?.snippet && new RegExp(TERM, 'i').test(match.snippet)),
    'result includes a matched snippet',
  );
  assert(!hits.some((row) => row.id === deleted.id), 'soft-deleted projects are excluded');

  // `hits.length <= 20` used to stand for this and only restated the SQL LIMIT
  // against an unbounded corpus. With a nonce term the corpus is exactly ours, so
  // the cap can be tested: 21 matching rows, an over-cap request, 20 back.
  await prisma.project.createMany({
    data: Array.from({ length: 20 }, (_unused, index) => ({
      name: `Nonce Filler ${index}`,
      initialPrompt: `A ${TERM} brief number ${index}.`,
      ownerId: owner.id,
      status: 'draft',
    })),
  });
  const capped = await searchProjects({ q: TERM, limit: 50 });
  assert(capped.length === 20, 'an over-cap limit is clamped to 20 rows');
} finally {
  if (owner) {
    // By owner, not by id: the filler rows above have no ids of their own here.
    await prisma.project.deleteMany({ where: { ownerId: owner.id } });
    await prisma.user.delete({ where: { id: owner.id } });
  }
  await prisma.$disconnect();
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
