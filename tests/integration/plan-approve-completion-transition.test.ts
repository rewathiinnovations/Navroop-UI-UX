import '../setup/env';
import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { testPrismaClient } from '../setup/db';
import { sliceBetween } from '../setup/source-slice';

/**
 * F-665: `approvePlan` carried
 *
 * ```
 * // TODO: set phase COMPLETE when generation reports a clean completion
 * // signal. persistProjectGeneration maps generationStatus "ready" → COMPLETE.
 * ```
 *
 * as the last statement before its return, which read as "the completion
 * transition is missing here". It is not missing, and it must not be written
 * here: `approvePlan` returns before a single token has been generated, so at
 * that point there is no `lastCode` and no checkpoint. Writing COMPLETE on the
 * approve path is precisely the bug `settle-generation.ts` is built to prevent
 * — a project that says "finished site" over an empty one.
 *
 * Phase is a side effect of job transitions (AGENTS.md, Jobs). The transition
 * this suite pins is the real one: approve claims PLANNING → BUILDING and
 * creates the BUILD job; settling that job with files is what makes the project
 * COMPLETE, and settling it with nothing leaves it out of COMPLETE.
 */

const prisma = testPrismaClient();

const OWNER = 'user_plan_complete_owner';
const PROJECT = 'proj_plan_complete';

type Actor = { id: string; email: string; name: string; role: 'MEMBER' | 'ADMIN' };

const OWNER_ACTOR: Actor = {
  id: OWNER,
  email: 'plan-complete-owner@example.com',
  name: 'Plan completion owner',
  role: 'MEMBER',
};

const session = vi.hoisted(() => ({ user: null as Actor | null }));

/** next-auth cannot load under the node test environment. */
vi.mock('@/lib/auth', () => ({
  getSessionUser: async () => session.user,
}));

import { approvePlan, generatePlan, runWithPlanCompleter } from '@/lib/projects/plan';
import { settleStreamedGeneration } from '@/lib/jobs/settle-generation';

const PLAN_CONTENT = {
  summary: 'A one page bakery site',
  pages: [{ name: 'Home', description: 'A landing page to sell bread' }],
  keyFeatures: ['Hero', 'Menu'],
  stack: 'NEXTJS',
};

function withPlan<T>(fn: () => Promise<T>) {
  return runWithPlanCompleter(async () => PLAN_CONTENT, fn);
}

async function resetProject() {
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
  await prisma.$executeRaw`DELETE FROM "GenerationJob" WHERE "projectId" = ${PROJECT}`.catch(
    () => undefined,
  );
  await prisma.project.deleteMany({ where: { id: PROJECT } });
  await prisma.project.create({
    data: {
      id: PROJECT,
      name: 'Plan completion probe',
      initialPrompt: 'A landing page for a bakery',
      ownerId: OWNER,
      stack: 'NEXTJS',
      designDirection: 'minimal',
      phase: 'PLANNING',
    },
  });
}

async function buildJobId() {
  const [row] = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "GenerationJob"
    WHERE "projectId" = ${PROJECT} AND kind = 'BUILD'
    ORDER BY "createdAt" DESC LIMIT 1
  `;
  if (!row) throw new Error('approvePlan created no BUILD job');
  return row.id;
}

async function projectRow() {
  return prisma.project.findUniqueOrThrow({
    where: { id: PROJECT },
    select: { phase: true, lastCode: true },
  });
}

beforeEach(async () => {
  session.user = OWNER_ACTOR;
  await resetProject();
});

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM "GenerationJob" WHERE "projectId" = ${PROJECT}`.catch(
    () => undefined,
  );
  await prisma.project.deleteMany({ where: { id: PROJECT } });
  await prisma.user.deleteMany({ where: { id: OWNER } });
  await prisma.$disconnect();
});

describe('the plan approve path does not own the completion transition (F-665)', () => {
  it('returns BUILDING over an empty site, and never writes COMPLETE itself', async () => {
    await withPlan(() => generatePlan(PROJECT, 'context', 'initial', 'message'));

    const result = await approvePlan(PROJECT);

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.data.phase).toBe('BUILDING');
    // Nothing has been generated yet. COMPLETE here would be the claim the
    // settle layer exists to refuse.
    const row = await projectRow();
    expect(row.phase).toBe('BUILDING');
    expect(row.lastCode).toBeNull();
  });

  it('reaches COMPLETE when the BUILD job approve created settles with files', async () => {
    await withPlan(() => generatePlan(PROJECT, 'context', 'initial', 'message'));
    await approvePlan(PROJECT);
    const jobId = await buildJobId();

    const settled = await settleStreamedGeneration({
      jobId,
      producedFiles: 1,
      streamedCode: [
        'Here is the page.',
        '```tsx{path=app/page.tsx}',
        'export default function Page() { return null; }',
        '```',
      ].join('\n'),
      provider: 'openai',
      model: 'gpt-4o-mini',
    });

    expect(settled.outcome).toBe('succeeded');
    const row = await projectRow();
    // COMPLETE is site evidence — lastCode — reached through the job's terminal
    // write, not through the request that approved the plan.
    expect(row.phase).toBe('COMPLETE');
    expect(row.lastCode).toContain('<file path="app/page.tsx">');
  });

  it('stays out of COMPLETE when that same job settles with no usable file', async () => {
    await withPlan(() => generatePlan(PROJECT, 'context', 'initial', 'message'));
    await approvePlan(PROJECT);
    const jobId = await buildJobId();

    const settled = await settleStreamedGeneration({
      jobId,
      producedFiles: 11,
      provider: 'google',
      model: 'gemini-2.5-flash',
    });

    expect(settled.outcome).toBe('failed');
    expect(settled.errorCode).toBe('no_files_generated');
    const row = await projectRow();
    expect(row.phase).not.toBe('COMPLETE');
    expect(row.lastCode).toBeNull();
  });

  it('leaves no unimplemented-completion TODO on the approve path', () => {
    const source = readFileSync('lib/projects/plan.ts', 'utf8');
    const approve = sliceBetween(
      source,
      'export async function approvePlan(',
      'export async function retryFailedPlan(',
    );
    // The finding was the TODO itself: shipped code telling the next reader that
    // a transition it depends on has not been built. The three tests above are
    // what that comment should have pointed at.
    expect(approve).not.toMatch(/TODO/);
  });
});
