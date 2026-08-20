import '../setup/env';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { testPrismaClient } from '../setup/db';

/**
 * The two plan-lifecycle races, against one real Postgres because that is where both live.
 *
 * F-810 — `generatePlan` read `MAX(version)` with a `findFirst` *outside* the transaction
 * that inserted at that version, and `ProjectPlan` has no `@@unique([projectId, version])`,
 * so Postgres accepted the duplicate. Duplicate versions make `orderBy: { version: 'desc' }`
 * non-deterministic, and `approvePlan`, `getLatestPlan` and template creation all depend on
 * it picking the right row. The `PENDING → SUPERSEDED` sweep raced for the same reason, so
 * two plans could both end up PENDING.
 *
 * F-811 — `approvePlan` read the phase, asserted `PLANNING`, and only then flipped the
 * project to `BUILDING`. Nothing linked the check to the write, so two concurrent approvals
 * both passed the check, both committed, and both started a generation. The only thing
 * standing between that and two charged builds was the optional `idempotencyKey` from the
 * request body. AGENTS.md:68 states the rule the job layer already follows and this did not:
 * the win is the UPDATE row count, never a re-read.
 */

const prisma = testPrismaClient();

const OWNER = 'user_plan_race_owner';
const PROJECT = 'proj_plan_race';

type Actor = { id: string; email: string; name: string; role: 'MEMBER' | 'ADMIN' };

const OWNER_ACTOR: Actor = {
  id: OWNER,
  email: 'plan-race@example.com',
  name: 'Plan Race Owner',
  role: 'MEMBER',
};

const session = vi.hoisted(() => ({ user: null as Actor | null }));

/** next-auth cannot load under the node test environment. */
vi.mock('@/lib/auth', () => ({
  getSessionUser: async () => session.user,
}));

import { approvePlan, generatePlan, runWithPlanCompleter } from '@/lib/projects/plan';
// Namespace import purely to assert on the module's export surface below.
import * as planModule from '@/lib/projects/plan';

const PLAN_CONTENT = {
  summary: 'A bakery landing page',
  pages: [{ name: 'Home', description: 'Hero, menu, contact' }],
  keyFeatures: ['Menu', 'Contact form'],
};

/**
 * The completer is scoped to the callback rather than assigned to a module global
 * (F-813), so a suite that throws mid-test cannot leave the AI call replaced for
 * whatever runs next in the same process.
 */
function withPlan<T>(fn: () => Promise<T>) {
  return runWithPlanCompleter(async () => PLAN_CONTENT, fn);
}

async function resetProject(phase: 'PLANNING' | 'BUILDING' | 'COMPLETE' = 'PLANNING') {
  await prisma.user.upsert({
    where: { id: OWNER },
    create: {
      id: OWNER,
      email: OWNER_ACTOR.email,
      name: OWNER_ACTOR.name,
      role: 'MEMBER',
      passwordHash: 'not-a-real-hash',
    },
    update: {},
  });
  await prisma.project.deleteMany({ where: { id: PROJECT } });
  await prisma.project.create({
    data: {
      id: PROJECT,
      name: 'Plan race probe',
      initialPrompt: 'A landing page for a bakery',
      ownerId: OWNER,
      stack: 'NEXTJS',
      designDirection: 'minimal',
      phase,
    },
  });
}

beforeEach(async () => {
  session.user = OWNER_ACTOR;
  await resetProject();
});

afterAll(async () => {
  await prisma.project.deleteMany({ where: { id: PROJECT } });
  await prisma.user.deleteMany({ where: { id: OWNER } });
  await prisma.$disconnect();
});

describe('plan versions are allocated one at a time (F-810)', () => {
  it('gives four concurrent plan generations four distinct versions', async () => {
    const created = await withPlan(() =>
      Promise.all(
        [1, 2, 3, 4].map((n) => generatePlan(PROJECT, `context ${n}`, 'initial', `message ${n}`)),
      ),
    );

    const versions = created.map((plan) => plan.version).sort((a, b) => a - b);
    expect(versions).toEqual([1, 2, 3, 4]);

    const stored = await prisma.projectPlan.findMany({
      where: { projectId: PROJECT },
      orderBy: { version: 'asc' },
      select: { version: true, status: true },
    });
    expect(stored.map((row) => row.version)).toEqual([1, 2, 3, 4]);
    // The supersede sweep is inside the same serialized transaction, so the newest plan is
    // the only pending one — `orderBy: { version: 'desc' }` picks it deterministically.
    expect(stored.filter((row) => row.status === 'PENDING')).toHaveLength(1);
    expect(stored[3].status).toBe('PENDING');
  });

  it('continues the series after the existing plans', async () => {
    await prisma.projectPlan.create({
      data: {
        projectId: PROJECT,
        version: 9,
        content: PLAN_CONTENT,
        status: 'SUPERSEDED',
        sourceMessage: 'earlier',
        trigger: 'initial',
      },
    });

    const plan = await withPlan(() => generatePlan(PROJECT, 'context', 'followup', 'message'));
    expect(plan.version).toBe(10);
  });
});

describe('approvePlan is a guarded conditional write (F-811)', () => {
  it('admits one of two concurrent approvals with no idempotency key', async () => {
    await withPlan(() => generatePlan(PROJECT, 'context', 'initial', 'message'));

    const results = await Promise.all([approvePlan(PROJECT), approvePlan(PROJECT)]);

    const admitted = results.filter((result) => result.ok);
    const refused = results.filter((result) => !result.ok);
    expect(admitted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].ok === false && refused[0].status).toBe(409);

    // One approval, one build, one charged generation. `logGenerationEvent` is what
    // `/admin/usage` and the cost model are built on, so a second row is a second charge.
    const events = await prisma.generationEvent.count({
      where: { projectId: PROJECT, kind: 'initial' },
    });
    expect(events).toBe(1);
    const approved = await prisma.projectPlan.count({
      where: { projectId: PROJECT, status: 'APPROVED' },
    });
    expect(approved).toBe(1);
    const builds = await prisma.job.count({ where: { projectId: PROJECT, kind: 'BUILD' } });
    expect(builds).toBe(1);
  });

  it('leaves the project in PLANNING when there is no pending plan to approve', async () => {
    const result = await approvePlan(PROJECT);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.status).toBe(409);
    // The phase claim is rolled back with the rest of the transaction: a refused approval
    // must not strand the project in BUILDING with no job.
    const row = await prisma.project.findUniqueOrThrow({
      where: { id: PROJECT },
      select: { phase: true },
    });
    expect(row.phase).toBe('PLANNING');
  });

  it('refuses a project that is already building', async () => {
    await withPlan(() => generatePlan(PROJECT, 'context', 'initial', 'message'));
    await prisma.project.update({ where: { id: PROJECT }, data: { phase: 'BUILDING' } });

    const result = await approvePlan(PROJECT);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.status).toBe(409);
  });
});

// F-813: the seam used to be `setPlanCompleter`, a module global that replaced the AI
// call for every user of the process until something set it back — and production also
// kept the last generation's prompt and approved plan JSON in a `lastGenerationStart`
// global read by nothing but an unwired acceptance script.
describe('the plan-completer seam is call-scoped (F-813)', () => {
  it('does not survive the callback that installed it', async () => {
    const first = await withPlan(() => generatePlan(PROJECT, 'context', 'initial', 'message'));
    expect(first.version).toBe(1);

    // Outside the scope there is no stub, so this reaches the real provider chain — which
    // is unconfigured here and refuses. If the completer had leaked, this would succeed.
    await expect(generatePlan(PROJECT, 'context', 'followup', 'message')).rejects.toThrow();

    const plans = await prisma.projectPlan.count({ where: { projectId: PROJECT } });
    expect(plans, 'a leaked completer wrote a second plan').toBe(1);
  });

  it('exports no process-global generation-start peek', () => {
    const exported = Object.keys(planModule);
    expect(exported).not.toContain('peekLastGenerationStart');
    expect(exported).not.toContain('setPlanCompleter');
    // Control: the namespace really is this module.
    expect(exported).toContain('runWithPlanCompleter');
  });
});
