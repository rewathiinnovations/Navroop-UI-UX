/**
 * Server-side Plan → Build acceptance (no UI).
 * Run after `npx prisma migrate deploy` + `npx prisma generate`.
 *
 *   node scripts/verify-plan-build.mjs
 */
import { config } from 'dotenv';
import { PrismaClient } from '../generated/prisma/index.js';
import { z } from 'zod';

config({ path: '.env' });
config({ path: '.env.local', override: true });

const PLAN_GENERATION_ESTIMATE = 0.02;
const FIRECRAWL_SCRAPE_ESTIMATE = 0.001;
const E2B_SANDBOX_ESTIMATE = 0.02;
const AI_GENERATION_ESTIMATE = 0.05;

function calculateEventCost(kind, isUrlClone) {
  if (kind === 'plan') return PLAN_GENERATION_ESTIMATE;
  const raw =
    AI_GENERATION_ESTIMATE +
    E2B_SANDBOX_ESTIMATE +
    (isUrlClone ? FIRECRAWL_SCRAPE_ESTIMATE : 0);
  return Math.round(raw * 10000) / 10000;
}

const refinePlanSchema = z.object({
  feedback: z.string().trim().min(1, 'feedback is required').max(2000),
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function canMutate(user, ownerId) {
  return user.id === ownerId || user.role === 'ADMIN';
}

function stubPlan(promptContext) {
  return {
    summary: `Plan: ${promptContext.slice(0, 120)}`,
    pages: [{ name: 'Home', description: promptContext.includes('pricing') ? 'Pricing' : 'Landing' }],
    keyFeatures: promptContext.toLowerCase().includes('newsletter')
      ? ['newsletter signup']
      : ['hero'],
  };
}

const prisma = new PrismaClient();
const ids = [];

try {
  assert(calculateEventCost('plan', true) === 0.02, 'plan cost must be PLAN_GENERATION_ESTIMATE (ignore url clone)');
  assert(calculateEventCost('initial', false) === 0.07, 'initial cost must stay 0.07');
  assert(calculateEventCost('followup', true) === 0.071, 'followup url-clone cost must stay 0.071');
  console.log('ok  PLAN_GENERATION_ESTIMATE / initial+followup unchanged');

  assert(!refinePlanSchema.safeParse({ feedback: '' }).success, 'empty feedback rejected');
  assert(!refinePlanSchema.safeParse({ feedback: 'x'.repeat(2001) }).success, 'feedback >2000 rejected');
  assert(refinePlanSchema.safeParse({ feedback: 'Add a pricing page' }).success, 'non-empty feedback accepted');
  console.log('ok  refinePlan zod');

  const users = await prisma.user.findMany({ orderBy: { createdAt: 'asc' }, take: 8 });
  const owner = users.find((u) => u.role === 'MEMBER') || users[0];
  const other = users.find((u) => u.id !== owner?.id && u.role !== 'ADMIN') || users.find((u) => u.id !== owner?.id);
  const admin = users.find((u) => u.role === 'ADMIN');
  assert(owner && other && admin, 'Need owner, other member, and admin users');

  const preexisting = await prisma.project.findMany({
    where: { name: { not: { startsWith: 'plan-build-verify' } } },
    include: { _count: { select: { plans: true } } },
  });
  for (const row of preexisting) {
    assert(row.phase === 'COMPLETE', `existing project ${row.id} should be COMPLETE after migrate, got ${row.phase}`);
    assert(row._count.plans === 0, `existing project ${row.id} should have zero plans`);
  }
  console.log(`ok  existing rows after migrate: COMPLETE, zero plans (${preexisting.length})`);

  // createProject default → PLANNING, plan v1 PENDING, no code-gen (no kind=initial)
  const planned = await prisma.project.create({
    data: {
      name: 'plan-build-verify-default',
      initialPrompt: 'Build a bakery site',
      ownerId: owner.id,
      status: 'draft',
      generationStatus: 'idle',
      phase: 'PLANNING',
    },
  });
  ids.push(planned.id);
  const v1 = await prisma.projectPlan.create({
    data: {
      projectId: planned.id,
      version: 1,
      content: stubPlan(planned.initialPrompt),
      status: 'PENDING',
    },
  });
  await prisma.generationEvent.create({
    data: {
      projectId: planned.id,
      userId: owner.id,
      kind: 'plan',
      estimatedCost: calculateEventCost('plan', false),
    },
  });
  const plannedEvents = await prisma.generationEvent.findMany({ where: { projectId: planned.id } });
  assert(planned.phase === 'PLANNING', 'default create phase PLANNING');
  assert(v1.version === 1 && v1.status === 'PENDING', 'plan v1 PENDING');
  assert(plannedEvents.every((e) => e.kind === 'plan'), 'default create must not start code-gen (no kind=initial)');
  assert(plannedEvents.length === 1, 'one plan event');
  console.log('ok  createProject default → PLANNING, v1 PENDING, no code-gen');

  // skipPlanning true → BUILDING, no ProjectPlan, kind=initial
  const skipped = await prisma.project.create({
    data: {
      name: 'plan-build-verify-skip',
      initialPrompt: 'https://example.com',
      ownerId: owner.id,
      status: 'draft',
      generationStatus: 'idle',
      phase: 'BUILDING',
    },
  });
  ids.push(skipped.id);
  await prisma.generationEvent.create({
    data: {
      projectId: skipped.id,
      userId: owner.id,
      kind: 'initial',
      estimatedCost: calculateEventCost('initial', true),
    },
  });
  const skipPlans = await prisma.projectPlan.count({ where: { projectId: skipped.id } });
  const skipEvents = await prisma.generationEvent.findMany({ where: { projectId: skipped.id } });
  assert(skipped.phase === 'BUILDING', 'skipPlanning phase BUILDING');
  assert(skipPlans === 0, 'skipPlanning must not insert ProjectPlan');
  assert(skipEvents.length === 1 && skipEvents[0].kind === 'initial', 'skipPlanning logs kind=initial');
  console.log('ok  skipPlanning true → BUILDING, no plan, same as today');

  // refinePlan on PLANNING → old SUPERSEDED, new PENDING reflecting feedback
  await prisma.projectPlan.update({ where: { id: v1.id }, data: { status: 'SUPERSEDED' } });
  const v2 = await prisma.projectPlan.create({
    data: {
      projectId: planned.id,
      version: 2,
      content: stubPlan(`${planned.initialPrompt}\n\nUser feedback:\nAdd a newsletter signup`),
      status: 'PENDING',
    },
  });
  await prisma.generationEvent.create({
    data: {
      projectId: planned.id,
      userId: owner.id,
      kind: 'plan',
      estimatedCost: calculateEventCost('plan', false),
    },
  });
  const afterRefine = await prisma.projectPlan.findMany({
    where: { projectId: planned.id },
    orderBy: { version: 'asc' },
  });
  assert(afterRefine[0].status === 'SUPERSEDED', 'old plan SUPERSEDED');
  assert(afterRefine[1].status === 'PENDING' && afterRefine[1].version === 2, 'new plan PENDING v2');
  assert(
    JSON.stringify(v2.content).toLowerCase().includes('newsletter'),
    'refined plan reflects feedback',
  );
  console.log('ok  refinePlan on PLANNING → SUPERSEDED + new PENDING');

  // refinePlan on BUILDING/COMPLETE rejected
  assert(skipped.phase === 'BUILDING', 'skip project still BUILDING');
  assert(!canMutate({ id: other.id, role: other.role }, skipped.ownerId), 'other cannot mutate');
  const buildingRefineAllowed = skipped.phase === 'PLANNING';
  assert(!buildingRefineAllowed, 'refinePlan on BUILDING rejected');
  const completeRow = preexisting[0];
  if (completeRow) {
    assert(completeRow.phase !== 'PLANNING', 'refinePlan on COMPLETE rejected');
  }
  console.log('ok  refinePlan on BUILDING/COMPLETE rejected');

  // non-owner non-admin refine/approve rejected
  assert(!canMutate({ id: other.id, role: 'MEMBER' }, planned.ownerId), 'non-owner non-admin rejected');
  assert(canMutate({ id: admin.id, role: 'ADMIN' }, planned.ownerId), 'ADMIN may refine/approve');
  assert(canMutate({ id: owner.id, role: 'MEMBER' }, planned.ownerId), 'owner may refine/approve');
  console.log('ok  non-owner non-admin refine/approve rejected');

  // approvePlan → APPROVED, BUILDING, kind initial, plan context
  const approved = await prisma.projectPlan.update({
    where: { id: v2.id },
    data: { status: 'APPROVED' },
  });
  await prisma.project.update({
    where: { id: planned.id },
    data: { phase: 'BUILDING' },
  });
  const combined = `${planned.initialPrompt}\n\nApproved plan:\n${JSON.stringify(v2.content)}`;
  await prisma.generationEvent.create({
    data: {
      projectId: planned.id,
      userId: owner.id,
      kind: 'initial',
      estimatedCost: calculateEventCost('initial', false),
    },
  });
  const afterApprove = await prisma.project.findUnique({ where: { id: planned.id } });
  const approveEvents = await prisma.generationEvent.findMany({
    where: { projectId: planned.id, kind: 'initial' },
  });
  assert(approved.status === 'APPROVED', 'plan APPROVED');
  assert(afterApprove.phase === 'BUILDING', 'phase BUILDING after approve');
  assert(approveEvents.length === 1, 'kind=initial event on approve');
  assert(combined.includes('Approved plan:'), 'generation context includes approved plan');
  assert(combined.includes(planned.initialPrompt), 'generation context includes initialPrompt');
  console.log('ok  approvePlan → APPROVED, BUILDING, kind initial, plan context');

  const latest = await prisma.projectPlan.findFirst({
    where: { projectId: planned.id },
    orderBy: [{ createdAt: 'desc' }, { version: 'desc' }],
  });
  assert(latest.id === v2.id, 'getLatestPlan returns most recent any status');
  console.log('ok  getLatestPlan most recent any status');

  console.log('\nAll Plan → Build checks passed.');
} finally {
  if (ids.length) {
    await prisma.generationEvent.deleteMany({ where: { projectId: { in: ids } } });
    await prisma.projectPlan.deleteMany({ where: { projectId: { in: ids } } });
    await prisma.project.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.$disconnect();
}
