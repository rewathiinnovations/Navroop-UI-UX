import '../setup/env';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { testPrismaClient } from '../setup/db';

/**
 * F-814 — `buildMemoryBlock` was wrapped in a try whose catch was
 * `console.warn('[memory] plan block failed', error)`. Brain memory is documented as
 * always-on and inside the cacheable prefix (AGENTS.md:61), so when it silently vanished
 * the plan was generated without the workspace's durable context *and* the stable prefix
 * bytes changed, missing the prompt cache. Neither the user nor Sentry learned why the
 * plan ignored known context.
 *
 * The plan must still be produced — memory is best effort — but the loss has to be
 * reported, so both halves are asserted here against one real Postgres.
 */

const prisma = testPrismaClient();

const OWNER = 'user_plan_memory_owner';
const PROJECT = 'proj_plan_memory';

type Actor = { id: string; email: string; name: string; role: 'MEMBER' | 'ADMIN' };

const OWNER_ACTOR: Actor = {
  id: OWNER,
  email: 'plan-memory@example.com',
  name: 'Plan Memory Owner',
  role: 'MEMBER',
};

const session = vi.hoisted(() => ({ user: null as Actor | null }));
const memory = vi.hoisted(() => ({ fail: false }));
const logged = vi.hoisted(() => ({ errors: [] as Array<{ event: string; fields?: unknown }> }));

/** next-auth cannot load under the node test environment. */
vi.mock('@/lib/auth', () => ({
  getSessionUser: async () => session.user,
}));

vi.mock('@/lib/memory/build-context', () => ({
  buildMemoryBlock: async () => {
    if (memory.fail) throw new Error('memory store unreachable');
    return { block: 'REMEMBER: the bakery is called Flour & Salt', entries: 1 };
  },
}));

// `logError` is the channel under test: the point of the fix is that this failure reaches
// Sentry with the project id instead of stdout. The real module writes to both.
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>();
  return {
    ...actual,
    logError: (event: string, error: unknown, fields?: Record<string, unknown>) => {
      logged.errors.push({ event, fields });
      return actual.logError(event, error, fields, { capture: false });
    },
  };
});

import { generatePlan, runWithPlanCompleter } from '@/lib/projects/plan';

const PLAN_CONTENT = {
  summary: 'A bakery landing page',
  pages: [{ name: 'Home', description: 'Hero, menu, contact' }],
  keyFeatures: ['Menu', 'Contact form'],
};

/** Captures the system prompt the completer is handed, so the memory text can be checked. */
function planWithCapture() {
  const seen: Array<{ systemPrompt: string; stablePrefix?: string }> = [];
  const run = () =>
    runWithPlanCompleter(
      async ({ systemPrompt, stablePrefix }) => {
        seen.push({ systemPrompt, stablePrefix });
        return PLAN_CONTENT;
      },
      () => generatePlan(PROJECT, 'A landing page for a bakery', 'initial', 'build it'),
    );
  return { seen, run };
}

beforeEach(async () => {
  session.user = OWNER_ACTOR;
  memory.fail = false;
  logged.errors = [];
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
      name: 'Plan memory probe',
      initialPrompt: 'A landing page for a bakery',
      ownerId: OWNER,
      stack: 'NEXTJS',
      designDirection: 'minimal',
      phase: 'PLANNING',
    },
  });
});

afterAll(async () => {
  await prisma.project.deleteMany({ where: { id: PROJECT } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: OWNER } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe('a failed Brain memory block is reported, not swallowed (F-814)', () => {
  it('records the loss with the project id and still writes the plan', async () => {
    memory.fail = true;
    const { seen, run } = planWithCapture();

    const plan = await run();
    // Best effort: the plan is still produced, which is why the failure needs its own
    // channel — nothing else about the run looks wrong.
    expect(plan.version).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].systemPrompt).not.toContain('Flour & Salt');

    const events = logged.errors.map((entry) => entry.event);
    expect(events, 'the memory failure never reached logError').toContain(
      'plan.memory_block_failed',
    );
    const recorded = logged.errors.find((entry) => entry.event === 'plan.memory_block_failed');
    expect(recorded?.fields).toMatchObject({ projectId: PROJECT });
  });

  // Control: without this the test above would pass against a build that never calls
  // `buildMemoryBlock` at all, and the "still writes the plan" half would prove nothing.
  it('control: a healthy memory block reaches the prompt and logs no error', async () => {
    const { seen, run } = planWithCapture();

    const plan = await run();
    expect(plan.version).toBe(1);
    expect(seen[0].systemPrompt).toContain('Flour & Salt');
    expect(seen[0].stablePrefix).toContain('Flour & Salt');
    expect(logged.errors.map((entry) => entry.event)).not.toContain('plan.memory_block_failed');
  });
});
