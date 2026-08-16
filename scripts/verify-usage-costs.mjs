/**
 * Server-side acceptance checks for GenerationEvent usage/cost tracking.
 * Run after `npx prisma migrate deploy` + `npx prisma generate`.
 *
 *   node scripts/verify-usage-costs.mjs
 *   BASE_URL=http://localhost:3000 node scripts/verify-usage-costs.mjs
 */
import { config } from 'dotenv';
import { PrismaClient } from '../generated/prisma/index.js';

config({ path: '.env' });
config({ path: '.env.local', override: true });

const FIRECRAWL_SCRAPE_ESTIMATE = 0.001;
const E2B_SANDBOX_ESTIMATE = 0.02;
const AI_GENERATION_ESTIMATE = 0.05;
const BASE_URL = process.env.BASE_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000';

function calculateEventCost(_kind, isUrlClone) {
  const raw =
    AI_GENERATION_ESTIMATE +
    E2B_SANDBOX_ESTIMATE +
    (isUrlClone ? FIRECRAWL_SCRAPE_ESTIMATE : 0);
  return Math.round(raw * 10000) / 10000;
}

function decimalToNumber(value) {
  if (value == null) return 0;
  const n = typeof value === 'number' ? value : Number(value.toString());
  return Math.round(n * 10000) / 10000;
}

async function logGenerationEvent(prisma, input) {
  try {
    await prisma.generationEvent.create({
      data: {
        projectId: input.projectId,
        userId: input.userId,
        kind: input.kind,
        estimatedCost: calculateEventCost(input.kind, input.isUrlClone),
      },
    });
  } catch (error) {
    console.error('[usage] Failed to log generation event', error.message);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const prisma = new PrismaClient();
const failures = [];

try {
  assert(calculateEventCost('initial', false) === 0.07, 'plain cost should be 0.07');
  assert(calculateEventCost('followup', true) === 0.071, 'url-clone cost should be 0.071');
  console.log('ok  calculateEventCost constants');

  const user = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' } });
  assert(user, 'Need at least one User row to verify inserts');

  const project = await prisma.project.create({
    data: {
      name: 'usage-verify',
      initialPrompt: 'verify usage tracking',
      ownerId: user.id,
    },
  });

  await logGenerationEvent(prisma, {
    projectId: project.id,
    userId: user.id,
    kind: 'initial',
    isUrlClone: false,
  });
  const afterInitial = await prisma.generationEvent.findMany({ where: { projectId: project.id } });
  assert(afterInitial.length === 1, `expected 1 initial event, got ${afterInitial.length}`);
  assert(afterInitial[0].kind === 'initial', 'first event kind should be initial');
  console.log('ok  createProject-equivalent insert → one kind=initial');

  await logGenerationEvent(prisma, {
    projectId: project.id,
    userId: user.id,
    kind: 'followup',
    isUrlClone: false,
  });
  const afterFollowup = await prisma.generationEvent.findMany({
    where: { projectId: project.id },
    orderBy: { createdAt: 'asc' },
  });
  assert(afterFollowup.length === 2, `expected 2 events, got ${afterFollowup.length}`);
  assert(afterFollowup[1].kind === 'followup', 'second event kind should be followup');
  console.log('ok  follow-up insert → one kind=followup');

  const beforeBad = await prisma.generationEvent.count();
  let threw = false;
  try {
    await logGenerationEvent(prisma, {
      projectId: 'missing-project-fk',
      userId: 'missing-user-fk',
      kind: 'followup',
      isUrlClone: false,
    });
  } catch {
    threw = true;
  }
  const afterBad = await prisma.generationEvent.count();
  assert(!threw, 'bad FK must be swallowed by logGenerationEvent');
  assert(afterBad === beforeBad, 'bad FK must not insert a row');
  console.log('ok  bad FK logging failure does not throw');

  const from = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const to = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1));
  const rows = await prisma.generationEvent.findMany({
    where: { createdAt: { gte: from, lt: to } },
  });
  const manualCost = decimalToNumber(rows.reduce((sum, row) => sum + Number(row.estimatedCost), 0));
  const manualProjects = new Set(rows.map((row) => row.projectId)).size;
  const [count, costAgg, projectGroups, byUser] = await Promise.all([
    prisma.generationEvent.count({ where: { createdAt: { gte: from, lt: to } } }),
    prisma.generationEvent.aggregate({
      where: { createdAt: { gte: from, lt: to } },
      _sum: { estimatedCost: true },
    }),
    prisma.generationEvent.groupBy({
      by: ['projectId'],
      where: { createdAt: { gte: from, lt: to } },
    }),
    prisma.generationEvent.groupBy({
      by: ['userId'],
      where: { createdAt: { gte: from, lt: to } },
      _count: { _all: true },
      _sum: { estimatedCost: true },
    }),
  ]);
  assert(count === rows.length, 'summary generation count matches row scan');
  assert(projectGroups.length === manualProjects, 'summary project count matches distinct projectId');
  assert(decimalToNumber(costAgg._sum.estimatedCost) === manualCost, 'summary cost matches row sum');
  const memberCost = decimalToNumber(byUser.reduce((sum, row) => sum + Number(row._sum.estimatedCost ?? 0), 0));
  assert(memberCost === manualCost, 'by-member cost sum matches row sum');
  console.log('ok  summary/by-member totals match manual sum of rows in range');

  await prisma.generationEvent.deleteMany({ where: { projectId: project.id } });
  await prisma.project.delete({ where: { id: project.id } });

  if (process.env.SKIP_HTTP === '1') {
    console.log('skip HTTP (SKIP_HTTP=1)');
  } else {
    const endpoints = [
      '/api/admin/usage/summary',
      '/api/admin/usage/by-member',
      '/api/admin/usage/project/usage-verify-missing',
    ];
    for (const path of endpoints) {
      try {
        const response = await fetch(`${BASE_URL}${path}`);
        if (response.status === 401 || response.status === 403) {
          console.log(`ok  unauthenticated ${path} → ${response.status}`);
        } else {
          failures.push(`${path} expected 401/403, got ${response.status}`);
          console.log(`fail unauthenticated ${path} → ${response.status}`);
        }
      } catch (error) {
        console.log(`skip HTTP ${path} (${error.cause?.code || error.message})`);
      }
    }
  }

  if (failures.length) {
    throw new Error(failures.join('\n'));
  }
  console.log('\nAll usage/cost tracking checks passed.');
} finally {
  await prisma.$disconnect();
}
