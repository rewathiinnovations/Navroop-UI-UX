import '../setup/env';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { testPrismaClient } from '../setup/db';
import { recordRevertRate, recordThumbs, recordVisualEditRate } from '@/lib/signals/collect';

/**
 * A quality signal belongs to the prompt version that produced the output it
 * judges, never to whatever happens to be active when the user clicks.
 *
 * `latestBuildEvent` already selects `promptVersion`, and `maybeSettleFollowups`,
 * `recordSeoScore` and `recordCodeAuditSignals` all pass it through.
 * `recordThumbs` and `recordRevertRate` kept only `?.id` and threw the version
 * away, so `writeSignal`'s `|| stampActivePromptHash()` fallback stamped the
 * live version instead — a thumbs-down on v2's output was recorded against v3
 * (F-815). `recordVisualEditRate` had the same hole on the branch where a
 * generation event id is supplied: it fabricated `{ id, promptVersion: null }`
 * rather than reading the event.
 *
 * AGENTS.md records this defect class as already fixed once on the generation
 * path ("prompt edits kept stamping generations with the stale version"); these
 * assertions pin the feedback path.
 */

const prisma = testPrismaClient();

const USER = 'user_signal_version';
const PROJECT = 'proj_signal_version';

/** Two distinct prefix hashes; neither is the hash the running code assembles. */
const OLD_VERSION = 'a'.repeat(64);
const NEW_VERSION = 'b'.repeat(64);

async function seed() {
  await prisma.user.upsert({
    where: { id: USER },
    create: {
      id: USER,
      email: 'signal-version@example.com',
      name: 'Signal version',
      role: 'MEMBER',
      passwordHash: 'not-a-real-hash',
    },
    update: {},
  });
  await prisma.project.upsert({
    where: { id: PROJECT },
    create: {
      id: PROJECT,
      name: 'Signal version',
      ownerId: USER,
      initialPrompt: 'prompt version probe',
    },
    update: {},
  });
}

async function addBuild(promptVersion: string, createdAt: Date) {
  return prisma.generationEvent.create({
    data: {
      projectId: PROJECT,
      userId: USER,
      kind: 'followup',
      estimatedCost: 0.05,
      promptVersion,
      createdAt,
    },
    select: { id: true },
  });
}

beforeEach(async () => {
  await seed();
  await prisma.qualitySignal.deleteMany({ where: { projectId: PROJECT } });
  await prisma.generationEvent.deleteMany({ where: { projectId: PROJECT } });
});

afterAll(async () => {
  await prisma.qualitySignal.deleteMany({ where: { projectId: PROJECT } }).catch(() => undefined);
  await prisma.generationEvent.deleteMany({ where: { projectId: PROJECT } }).catch(() => undefined);
  await prisma.project.deleteMany({ where: { id: PROJECT } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: USER } }).catch(() => undefined);
  await prisma.$disconnect();
});

async function signalOf(kind: string) {
  return prisma.qualitySignal.findFirstOrThrow({
    where: { projectId: PROJECT, kind },
    orderBy: { createdAt: 'desc' },
    select: { promptVersion: true, generationEventId: true, value: true },
  });
}

describe('feedback signals carry the prompt version of the generation they judge', () => {
  it('records a thumbs-up on an older generation against that generation’s version', async () => {
    const old = await addBuild(OLD_VERSION, new Date('2026-08-01T00:00:00Z'));
    // A newer build on a newer prompt: the active version has moved on since.
    await addBuild(NEW_VERSION, new Date('2026-08-10T00:00:00Z'));

    await recordThumbs(PROJECT, 'up', old.id);

    const signal = await signalOf('thumbs');
    expect(signal.generationEventId).toBe(old.id);
    expect(signal.promptVersion).toBe(OLD_VERSION);
    expect(signal.value).toBe(1);
  });

  it('records a thumbs-down against the latest generation’s version, not the live one', async () => {
    await addBuild(OLD_VERSION, new Date('2026-08-01T00:00:00Z'));
    const latest = await addBuild(NEW_VERSION, new Date('2026-08-10T00:00:00Z'));

    await recordThumbs(PROJECT, 'down');

    const signal = await signalOf('thumbs');
    expect(signal.generationEventId).toBe(latest.id);
    expect(signal.promptVersion).toBe(NEW_VERSION);
    expect(signal.value).toBe(0);
  });

  it('corrects the stamp when a thumbs is changed on the same generation', async () => {
    const old = await addBuild(OLD_VERSION, new Date('2026-08-01T00:00:00Z'));
    await prisma.qualitySignal.create({
      data: {
        projectId: PROJECT,
        generationEventId: old.id,
        kind: 'thumbs',
        value: 1,
        rawValue: { rating: 'up' },
        // What the old code wrote: the version live at the moment of the click.
        promptVersion: NEW_VERSION,
      },
    });

    await recordThumbs(PROJECT, 'down', old.id);

    const signal = await signalOf('thumbs');
    expect(signal.value).toBe(0);
    expect(signal.promptVersion).toBe(OLD_VERSION);
  });

  it('records a revert against the reverted generation’s version', async () => {
    const old = await addBuild(OLD_VERSION, new Date('2026-08-01T00:00:00Z'));
    await addBuild(NEW_VERSION, new Date('2026-08-10T00:00:00Z'));

    await recordRevertRate(PROJECT, old.id);

    const signal = await signalOf('revert_rate');
    expect(signal.generationEventId).toBe(old.id);
    expect(signal.promptVersion).toBe(OLD_VERSION);
  });

  it('reads the supplied generation event instead of fabricating a null version', async () => {
    const old = await addBuild(OLD_VERSION, new Date('2026-08-01T00:00:00Z'));
    await addBuild(NEW_VERSION, new Date('2026-08-10T00:00:00Z'));

    await recordVisualEditRate(PROJECT, 2, old.id);

    const signal = await signalOf('visual_edit_rate');
    expect(signal.generationEventId).toBe(old.id);
    expect(signal.promptVersion).toBe(OLD_VERSION);
  });

  it('falls back to the active version only when the project has no generation at all', async () => {
    await recordThumbs(PROJECT, 'up');

    const signal = await signalOf('thumbs');
    expect(signal.generationEventId).toBeNull();
    // The live hash — there is no generation to attribute this to.
    expect(signal.promptVersion).not.toBe(OLD_VERSION);
    expect(signal.promptVersion).not.toBe(NEW_VERSION);
    expect(signal.promptVersion).toHaveLength(64);
  });
});
