import '../setup/env';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { testPrismaClient } from '../setup/db';
import { CHECKPOINT_NOT_SAVED_NOTICE } from '@/lib/checkpoints/labels';

/**
 * A generation whose checkpoint failed to write must say so.
 *
 * `persistProjectGeneration` ran `createCheckpointAfterGeneration` and the preview build
 * inside one try whose catch was a bare `console.error`, then returned
 * `{ ok: true, previewNotice: null }` — a clean completion. The checkpoint is the source
 * of truth for a project with no sandbox: ZIP export, `collectPublishFiles` and version
 * restore all read it. A build that silently produced none leaves a project that cannot
 * be exported, published from a snapshot, or rolled back, while the UI said it finished
 * (F-807).
 *
 * The generation itself stays successful — the files are in `lastCode`. What has to
 * change is that the person is told the snapshot is missing, through the `previewNotice`
 * channel the return value already carries into chat.
 */

const prisma = testPrismaClient();

const USER = 'user_cp_failure';
const PROJECT = 'proj_cp_failure';

const checkpoint = { throws: null as Error | null };
const logged: string[] = [];

vi.mock('@/lib/auth', () => ({ getSessionUser: async () => null }));
vi.mock('@/lib/projects/plan', () => ({
  peekActor: () => ({ id: USER, email: 'cp-failure@example.com', role: 'ADMIN', name: 'CP' }),
  applyCreateProjectPlanFlow: async () => undefined,
}));
vi.mock('@/lib/checkpoints/actions', () => ({
  createCheckpointAfterGeneration: async () => {
    if (checkpoint.throws) throw checkpoint.throws;
    return { id: 'cp_ok', createdAt: new Date('2026-08-20T08:00:00.000Z') };
  },
}));
vi.mock('@/lib/memory/extract', () => ({
  extractMemoriesAfterGeneration: async () => undefined,
}));
vi.mock('@/lib/signals/collect', () => ({
  maybeSettleFollowups: async () => undefined,
  recordGenerationKept: async () => undefined,
}));
vi.mock('@/lib/preview/production', () => ({
  buildPreviewForProject: async () => ({ ok: true as const }),
}));
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>();
  return {
    ...actual,
    logError: (event: string) => {
      logged.push(event);
    },
  };
});

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: USER },
    create: {
      id: USER,
      email: 'cp-failure@example.com',
      name: 'CP',
      role: 'ADMIN',
      passwordHash: 'not-a-real-hash',
    },
    update: {},
  });
  await prisma.project.upsert({
    where: { id: PROJECT },
    create: { id: PROJECT, name: 'Checkpoint failure', ownerId: USER, initialPrompt: 'build it' },
    update: {},
  });
});

afterAll(async () => {
  await prisma.project.deleteMany({ where: { id: PROJECT } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: USER } }).catch(() => undefined);
  await prisma.$disconnect();
});

beforeEach(() => {
  checkpoint.throws = null;
  logged.length = 0;
});

describe('persistProjectGeneration when the checkpoint cannot be written', () => {
  it('reports the missing snapshot instead of a clean completion', async () => {
    const { persistProjectGeneration } = await import('@/lib/projects/actions');
    checkpoint.throws = new Error('storage limit is used up');

    const result = await persistProjectGeneration(PROJECT, { generationStatus: 'ready' });

    expect(result.ok).toBe(true);
    expect(result.previewNotice).toBe(CHECKPOINT_NOT_SAVED_NOTICE);
    expect(CHECKPOINT_NOT_SAVED_NOTICE).toMatch(/version history|snapshot/i);
  });

  it('logs the failure through logError, not console.error', async () => {
    const { persistProjectGeneration } = await import('@/lib/projects/actions');
    checkpoint.throws = new Error('storage limit is used up');

    await persistProjectGeneration(PROJECT, { generationStatus: 'ready' });

    expect(logged).toContain('projects.checkpoint_after_generation_failed');
  });

  // Control: a checkpoint that writes leaves the notice channel alone, so the assertion
  // above cannot be passing because every persist now carries a notice.
  it('control: a successful checkpoint reports no notice', async () => {
    const { persistProjectGeneration } = await import('@/lib/projects/actions');

    const result = await persistProjectGeneration(PROJECT, { generationStatus: 'ready' });

    expect(result.ok).toBe(true);
    expect(result.previewNotice).toBeNull();
    expect(logged).toEqual([]);
  });
});
