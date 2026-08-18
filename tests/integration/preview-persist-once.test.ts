import '../setup/env';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { testPrismaClient } from '../setup/db';
import { resetPreviewCaptureInflight } from '@/lib/preview/after-generation';

/**
 * persistProgress and saveCurrentProject can both PATCH ready for one generation.
 * persistProjectGeneration used to call capturePreviewAfterGeneration whenever
 * createCheckpointAfterGeneration returned an id — so a retry, a second tab, or
 * two overlapping ready persists billed a second sandbox preview.
 */

const prisma = testPrismaClient();

const USER = 'user_preview_once';
const PROJECT = 'proj_preview_once';
const CHECKPOINT = 'cp_preview_once';

const checkpoint = {
  id: CHECKPOINT,
  createdAt: new Date('2026-08-18T08:00:00.000Z'),
};

const buildCalls: string[] = [];

vi.mock('@/lib/auth', () => ({
  getSessionUser: async () => null,
}));
vi.mock('@/lib/projects/plan', () => ({
  peekActor: () => ({ id: USER, email: 'preview-once@example.com', role: 'ADMIN', name: 'Once' }),
  applyCreateProjectPlanFlow: async () => undefined,
}));
vi.mock('@/lib/checkpoints/actions', () => ({
  createCheckpointAfterGeneration: async () => checkpoint,
}));
vi.mock('@/lib/memory/extract', () => ({
  extractMemoriesAfterGeneration: async () => undefined,
}));
vi.mock('@/lib/signals/collect', () => ({
  countVisualEditsFromSource: () => 0,
  recordVisualEditRate: async () => undefined,
  maybeSettleFollowups: async () => undefined,
}));
vi.mock('@/lib/preview/production', () => ({
  buildPreviewForProject: async (projectId: string, checkpointId: string) => {
    buildCalls.push(`${projectId}:${checkpointId}`);
    return { ok: true as const };
  },
}));

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: USER },
    create: {
      id: USER,
      email: 'preview-once@example.com',
      name: 'Once',
      role: 'ADMIN',
      passwordHash: 'not-a-real-hash',
    },
    update: {},
  });
  await prisma.project.upsert({
    where: { id: PROJECT },
    create: { id: PROJECT, name: 'Preview once', ownerId: USER, initialPrompt: 'once' },
    update: {},
  });
});

afterAll(async () => {
  await prisma.previewBuild.deleteMany({ where: { projectId: PROJECT } }).catch(() => undefined);
  await prisma.project.deleteMany({ where: { id: PROJECT } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: USER } }).catch(() => undefined);
  await prisma.$disconnect();
});

beforeEach(() => {
  buildCalls.length = 0;
  resetPreviewCaptureInflight();
  checkpoint.id = CHECKPOINT;
  checkpoint.createdAt = new Date('2026-08-18T08:00:00.000Z');
});

afterEach(() => {
  resetPreviewCaptureInflight();
});

describe('persistProjectGeneration preview capture', () => {
  it('captures a preview once when ready persist runs twice for the same generation', async () => {
    const { persistProjectGeneration } = await import('@/lib/projects/actions');

    const first = await persistProjectGeneration(PROJECT, { generationStatus: 'ready' });
    const second = await persistProjectGeneration(PROJECT, { generationStatus: 'ready' });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(buildCalls).toEqual([`${PROJECT}:${CHECKPOINT}`]);
  });

  it('captures again when a later persist has a newer checkpoint', async () => {
    const { persistProjectGeneration } = await import('@/lib/projects/actions');

    await persistProjectGeneration(PROJECT, { generationStatus: 'ready' });
    checkpoint.id = 'cp_preview_once_newer';
    checkpoint.createdAt = new Date('2026-08-18T08:01:00.000Z');
    await persistProjectGeneration(PROJECT, { generationStatus: 'ready' });

    expect(buildCalls).toEqual([`${PROJECT}:${CHECKPOINT}`, `${PROJECT}:cp_preview_once_newer`]);

    checkpoint.id = CHECKPOINT;
    checkpoint.createdAt = new Date('2026-08-18T08:00:00.000Z');
  });
});

describe('overlapping preview adopt', () => {
  it('does not let an older READY build steal activePreviewBuildId', async () => {
    const table = prisma.previewBuild;
    await table.deleteMany({ where: { projectId: PROJECT } });
    const older = await table.create({
      data: {
        id: 'pb_older',
        projectId: PROJECT,
        checkpointId: 'cp_older',
        status: 'READY',
        mode: 'STATIC',
        createdAt: new Date('2026-08-18T08:00:00.000Z'),
      },
    });
    const newer = await table.create({
      data: {
        id: 'pb_newer',
        projectId: PROJECT,
        checkpointId: 'cp_newer',
        status: 'READY',
        mode: 'STATIC',
        createdAt: new Date('2026-08-18T08:01:00.000Z'),
      },
    });

    const { setProjectPreviewFields, getProjectPreviewFields } = await import('@/lib/preview/db');
    await setProjectPreviewFields(PROJECT, {
      previewMode: 'STATIC',
      activePreviewBuildId: newer.id,
      fromBuildId: newer.id,
    });
    await setProjectPreviewFields(PROJECT, {
      previewMode: 'STATIC',
      activePreviewBuildId: older.id,
      fromBuildId: older.id,
    });

    const fields = await getProjectPreviewFields(PROJECT);
    expect(fields?.activePreviewBuildId).toBe(newer.id);
  });
});
