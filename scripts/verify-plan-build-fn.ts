/**
 * Calls the real Plan → Build functions (stubbed LLM).
 *   npx tsx scripts/verify-plan-build-fn.ts
 */
import { config } from 'dotenv';
import { prisma } from '../lib/db';
import { createProject } from '../lib/projects/actions';
import {
  approvePlan,
  getLatestPlan,
  peekLastGenerationStart,
  refinePlan,
  requestFollowUpPlan,
  runWithActor,
  setPlanCompleter,
} from '../lib/projects/plan';
import { shouldRequestFollowUpPlan } from '../components/workspace/types';
import { calculateEventCost, PLAN_GENERATION_ESTIMATE } from '../lib/usage-costs';
import type { SessionUser } from '../lib/auth';

config({ path: '.env' });
config({ path: '.env.local', override: true });

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

setPlanCompleter(async ({ promptContext }) => ({
  summary: `Plan: ${promptContext.slice(0, 160)}`,
  pages: [{ name: 'Home', description: promptContext.includes('pricing') ? 'Pricing' : 'Landing' }],
  keyFeatures: promptContext.toLowerCase().includes('newsletter')
    ? ['newsletter signup']
    : ['hero'],
}));

const ids: string[] = [];

try {
  assert(calculateEventCost('plan', true) === PLAN_GENERATION_ESTIMATE, 'plan cost');
  assert(calculateEventCost('initial', false) === 0.07, 'initial unchanged');

  const users = await prisma.user.findMany({ orderBy: { createdAt: 'asc' }, take: 8 });
  const ownerRow = users.find((u) => u.role === 'MEMBER') || users[0];
  const otherRow = users.find((u) => u.id !== ownerRow?.id && u.role !== 'ADMIN');
  const adminRow = users.find((u) => u.role === 'ADMIN');
  assert(ownerRow && otherRow && adminRow, 'Need owner, other member, and admin');

  const toActor = (row: typeof ownerRow): SessionUser => ({
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    avatarUrl: row.avatarUrl,
  });
  const owner = toActor(ownerRow);
  const other = toActor(otherRow);
  const admin = toActor(adminRow);

  const created = await runWithActor(owner, () =>
    createProject({ initialPrompt: 'Build a bakery site with a menu' }),
  );
  assert(created.ok, `createProject default failed: ${'error' in created ? created.error : ''}`);
  ids.push(created.data.id);
  assert(created.data.phase === 'PLANNING', 'default phase PLANNING');
  assert(created.data.plan?.version === 1 && created.data.plan.status === 'PENDING', 'v1 PENDING');
  assert(created.data.plan?.trigger === 'initial', 'createPlan trigger initial');
  assert(created.data.plan?.sourceMessage === 'Build a bakery site with a menu', 'createPlan sourceMessage');
  const defaultEvents = await prisma.generationEvent.findMany({ where: { projectId: created.data.id } });
  assert(defaultEvents.length === 1 && defaultEvents[0].kind === 'plan', 'no code-gen on default create');
  console.log('ok  createProject default → PLANNING, v1 PENDING, no code-gen');

  const skipped = await runWithActor(owner, () =>
    createProject({ initialPrompt: 'https://example.com', skipPlanning: true }),
  );
  assert(skipped.ok, 'skipPlanning create failed');
  ids.push(skipped.data.id);
  assert(skipped.data.phase === 'BUILDING', 'skipPlanning phase BUILDING');
  assert(skipped.data.plan == null, 'skipPlanning has no plan');
  const skipPlanCount = await prisma.projectPlan.count({ where: { projectId: skipped.data.id } });
  const skipEvents = await prisma.generationEvent.findMany({ where: { projectId: skipped.data.id } });
  assert(skipPlanCount === 0, 'no ProjectPlan row');
  assert(skipEvents.length === 1 && skipEvents[0].kind === 'initial', 'kind initial');
  console.log('ok  skipPlanning true → BUILDING, no plan, kind initial');

  const refined = await runWithActor(owner, () =>
    refinePlan(created.data.id, 'Add a newsletter signup'),
  );
  assert(refined.ok, `refinePlan failed: ${'error' in refined ? refined.error : ''}`);
  const plans = await prisma.projectPlan.findMany({
    where: { projectId: created.data.id },
    orderBy: { version: 'asc' },
  });
  assert(plans[0].status === 'SUPERSEDED', 'old SUPERSEDED');
  assert(plans[1].status === 'PENDING' && plans[1].version === 2, 'new PENDING v2');
  assert(plans[1].trigger === 'initial' && plans[1].sourceMessage === created.data.plan?.sourceMessage, 'refine keeps initial trigger');
  assert(JSON.stringify(plans[1].content).toLowerCase().includes('newsletter'), 'feedback reflected');
  console.log('ok  refinePlan on PLANNING → SUPERSEDED + new PENDING');

  const refineBuilding = await runWithActor(owner, () => refinePlan(skipped.data.id, 'Nope'));
  assert(!refineBuilding.ok && refineBuilding.status === 409, 'refine BUILDING rejected');
  console.log('ok  refinePlan on BUILDING rejected');

  const forbiddenRefine = await runWithActor(other, () =>
    refinePlan(created.data.id, 'Steal this plan'),
  );
  assert(!forbiddenRefine.ok && forbiddenRefine.status === 403, 'non-owner refine rejected');
  const adminRefine = await runWithActor(admin, () =>
    refinePlan(created.data.id, 'Admin tweak: add pricing'),
  );
  assert(adminRefine.ok, 'ADMIN may refine');
  console.log('ok  non-owner rejected; ADMIN allowed');

  const forbiddenApprove = await runWithActor(other, () => approvePlan(created.data.id));
  assert(!forbiddenApprove.ok && forbiddenApprove.status === 403, 'non-owner approve rejected');

  const approved = await runWithActor(owner, () => approvePlan(created.data.id));
  assert(approved.ok, `approvePlan failed: ${'error' in approved ? approved.error : ''}`);
  const after = await prisma.project.findUnique({ where: { id: created.data.id } });
  const latest = await runWithActor(owner, () => getLatestPlan(created.data.id));
  assert(after?.phase === 'BUILDING', 'phase BUILDING');
  assert(latest.ok && latest.data?.status === 'APPROVED', 'latest is APPROVED');
  const initialEvents = await prisma.generationEvent.findMany({
    where: { projectId: created.data.id, kind: 'initial' },
  });
  assert(initialEvents.length === 1, 'kind initial on approve');
  console.log('ok  approvePlan → APPROVED, BUILDING, kind initial, plan context');

  const refineAfterApprove = await runWithActor(owner, () => refinePlan(created.data.id, 'Too late'));
  assert(!refineAfterApprove.ok, 'refine after BUILDING rejected');

  const initialStart = peekLastGenerationStart();
  assert(initialStart?.kind === 'initial', 'approve initial uses initial entry');
  assert(initialStart?.promptContext.includes('Build a bakery site with a menu'), 'approve initial uses initialPrompt');

  assert(!shouldRequestFollowUpPlan('build'), 'mode build bypasses planning');
  assert(!shouldRequestFollowUpPlan(undefined), 'default mode bypasses planning');
  assert(shouldRequestFollowUpPlan('plan'), 'mode plan requests follow-up plan');
  console.log('ok  mode build on COMPLETE still bypasses planning');

  const followSource = 'Add a catering page for weekend events';
  const complete = await runWithActor(owner, () =>
    createProject({ initialPrompt: 'ORIGINAL INITIAL PROMPT bakery', skipPlanning: true }),
  );
  assert(complete.ok, 'complete fixture create failed');
  ids.push(complete.data.id);
  await prisma.project.update({
    where: { id: complete.data.id },
    data: {
      phase: 'COMPLETE',
      lastCode: '<file path="src/App.jsx">export default function App(){return <h1>Bakery</h1>}</file>',
    },
  });

  const pendingBlocked = await runWithActor(owner, () =>
    requestFollowUpPlan(created.data.id, followSource),
  );
  assert(
    !pendingBlocked.ok && pendingBlocked.status === 409 && pendingBlocked.error === 'A build is already in progress',
    'follow-up on BUILDING rejected',
  );

  const planningBlocked = await runWithActor(owner, async () => {
    await prisma.project.update({
      where: { id: skipped.data.id },
      data: { phase: 'PLANNING' },
    });
    return requestFollowUpPlan(skipped.data.id, followSource);
  });
  assert(
    !planningBlocked.ok && planningBlocked.status === 409 && planningBlocked.error === 'A plan is already pending',
    'follow-up on PLANNING rejected',
  );

  const forbiddenFollow = await runWithActor(other, () =>
    requestFollowUpPlan(complete.data.id, followSource),
  );
  assert(!forbiddenFollow.ok && forbiddenFollow.status === 403, 'non-owner follow-up rejected');

  const follow = await runWithActor(owner, () => requestFollowUpPlan(complete.data.id, followSource));
  assert(follow.ok, `requestFollowUpPlan failed: ${'error' in follow ? follow.error : ''}`);
  const afterFollow = await prisma.project.findUnique({ where: { id: complete.data.id } });
  assert(afterFollow?.phase === 'PLANNING', 'follow-up flips phase to PLANNING');
  assert(follow.data.trigger === 'followup', 'follow-up trigger');
  assert(follow.data.sourceMessage === followSource, 'follow-up sourceMessage exact');
  assert(JSON.stringify(follow.data.content).includes('src/App.jsx') || JSON.stringify(follow.data.content).includes(followSource), 'follow-up context includes file tree or message');
  console.log('ok  requestFollowUpPlan on COMPLETE → PLANNING, trigger followup');

  const refinedFollow = await runWithActor(owner, () =>
    refinePlan(complete.data.id, 'Also add a blog'),
  );
  assert(refinedFollow.ok, 'refine follow-up plan failed');
  assert(refinedFollow.data.trigger === 'followup', 'refine keeps followup trigger');
  assert(refinedFollow.data.sourceMessage === followSource, 'refine keeps followup sourceMessage');
  console.log('ok  refinePlan on followup plan keeps trigger followup');

  const approvedFollow = await runWithActor(owner, () => approvePlan(complete.data.id));
  assert(approvedFollow.ok, `approve follow-up failed: ${'error' in approvedFollow ? approvedFollow.error : ''}`);
  const followStart = peekLastGenerationStart();
  assert(followStart?.kind === 'followup', 'approve followup logs kind followup');
  assert(followStart?.promptContext.includes(followSource), 'approve followup uses sourceMessage');
  assert(!followStart?.promptContext.includes('ORIGINAL INITIAL PROMPT bakery'), 'approve followup does not use initialPrompt');
  const followEvents = await prisma.generationEvent.findMany({
    where: { projectId: complete.data.id, kind: 'followup' },
  });
  assert(followEvents.length === 1, 'followup GenerationEvent');
  console.log('ok  approvePlan followup → sourceMessage instruction, kind followup');

  console.log('\nAll Plan → Build function checks passed.');
} finally {
  setPlanCompleter(null);
  if (ids.length) {
    await prisma.generationEvent.deleteMany({ where: { projectId: { in: ids } } });
    await prisma.projectPlan.deleteMany({ where: { projectId: { in: ids } } });
    await prisma.project.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.$disconnect();
}
