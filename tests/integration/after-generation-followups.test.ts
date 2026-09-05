import '../setup/env';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { testPrismaClient } from '../setup/db';

/**
 * The three follow-ups after a successful generation were fired as `void promise`. A rejection
 * became an unhandled rejection with no project id and no task name — and one of them,
 * `maybeSettleFollowups`, mutates job state, so it could quietly fail to settle anything. They
 * are still detached (the generation already succeeded and none of this may fail the request),
 * but a failure is now a log line that names the project and the task.
 */

const prisma = testPrismaClient();

const USER = 'user_after_gen';
const PROJECT = 'proj_after_gen';

const settleFailure = { fail: false };

// next-auth cannot load under the node test environment; the actor comes from `peekActor`.
vi.mock('@/lib/auth', () => ({
  getSessionUser: async () => null,
}));
vi.mock('@/lib/projects/plan', () => ({
  peekActor: () => ({ id: USER, email: 'after-gen@example.com', role: 'ADMIN', name: 'After' }),
  applyCreateProjectPlanFlow: async () => undefined,
}));
vi.mock('@/lib/checkpoints/actions', () => ({
  createCheckpointAfterGeneration: async () => null,
}));
vi.mock('@/lib/memory/extract', () => ({
  extractMemoriesAfterGeneration: async () => undefined,
}));
vi.mock('@/lib/signals/collect', () => ({
  maybeSettleFollowups: async () => {
    if (settleFailure.fail) throw new Error('followup settle blew up');
  },
  recordGenerationKept: async () => undefined,
}));

let lines: string[];

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: USER },
    create: {
      id: USER,
      email: 'after-gen@example.com',
      name: 'After',
      role: 'ADMIN',
      passwordHash: 'not-a-real-hash',
    },
    update: {},
  });
  await prisma.project.upsert({
    where: { id: PROJECT },
    create: { id: PROJECT, name: 'After gen', ownerId: USER, initialPrompt: 'after gen probe' },
    update: {},
  });
});

afterAll(async () => {
  await prisma.project.deleteMany({ where: { id: PROJECT } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: USER } }).catch(() => undefined);
  await prisma.$disconnect();
});

beforeEach(() => {
  lines = [];
  settleFailure.fail = false;
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => lines.push(String(line)));
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The follow-ups are deliberately not awaited, so give the microtask queue a turn. */
const settleTicks = () => new Promise((resolve) => setTimeout(resolve, 30));

describe('post-generation follow-ups', () => {
  it('logs the project and the task when a follow-up rejects', async () => {
    settleFailure.fail = true;
    const { persistProjectGeneration } = await import('@/lib/projects/actions');

    const result = await persistProjectGeneration(PROJECT, {
      generationStatus: 'ready',
      sourceMessage: 'done',
    });
    await settleTicks();

    // The request still succeeds — the generation is finished and this is best-effort work.
    expect(result.ok).toBe(true);
    const logged = lines.join(' ');
    expect(logged).toContain('projects.after_generation_failed');
    expect(logged).toContain(PROJECT);
    expect(logged).toContain('settle_followups');
    expect(logged).toContain('followup settle blew up');
  });

  it('logs nothing when the follow-ups succeed', async () => {
    const { persistProjectGeneration } = await import('@/lib/projects/actions');

    const result = await persistProjectGeneration(PROJECT, {
      generationStatus: 'ready',
      sourceMessage: 'done',
    });
    await settleTicks();

    expect(result.ok).toBe(true);
    expect(lines.join(' ')).not.toContain('projects.after_generation_failed');
  });
});
