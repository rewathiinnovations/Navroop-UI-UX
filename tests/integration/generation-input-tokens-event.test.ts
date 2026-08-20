import '../setup/env';
import { afterAll, describe, expect, it } from 'vitest';
import { testPrismaClient } from '../setup/db';
import { attachGenerationInputTokens, logGenerationEvent } from '@/lib/usage-costs';
import { createProject } from '../factories/project';
import { createUser } from '../factories/user';

/**
 * Input tokens belong to the generation that spent them (F-749).
 *
 * `attachGenerationInputTokens` used to take a `projectId` and mutate whichever
 * `GenerationEvent` was newest for it. Two overlapping generations in one project — which
 * `withProjectLock` permits for the same user — then raced: the follow-up's row was newer,
 * so the plan's token count landed on it, and when the newer row already carried
 * `inputTokens` the older one's count was dropped with no log line at all. `/admin/usage`
 * and every cost built on `calculateEventCost` were then wrong in a way nobody could
 * reconstruct.
 *
 * Binding the write to the id `logGenerationEvent` returned is what makes the attribution
 * provable, and it can only be proven against real rows: the defect was entirely in which
 * row an `orderBy createdAt desc` picked.
 */

const prisma = testPrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

async function fixture() {
  const user = await createUser(prisma);
  const project = await createProject(prisma, { ownerId: user.id });
  return {
    user,
    project,
    async cleanup() {
      await prisma.generationEvent.deleteMany({ where: { projectId: project.id } });
      await prisma.project.delete({ where: { id: project.id } });
      await prisma.user.delete({ where: { id: user.id } });
    },
  };
}

describe('attachGenerationInputTokens', () => {
  it('updates only the event the run created, not the newest one for the project', async () => {
    const { user, project, cleanup } = await fixture();
    try {
      // Two overlapping runs in one project: the plan logs first, the follow-up second.
      const planEventId = await logGenerationEvent({
        projectId: project.id,
        userId: user.id,
        kind: 'plan',
        isUrlClone: false,
      });
      const followupEventId = await logGenerationEvent({
        projectId: project.id,
        userId: user.id,
        kind: 'followup',
        isUrlClone: false,
      });
      expect(planEventId).toBeTruthy();
      expect(followupEventId).not.toBe(planEventId);

      // The plan run finishes last and reports its own spend.
      await attachGenerationInputTokens(planEventId, 4321);

      const plan = await prisma.generationEvent.findUniqueOrThrow({
        where: { id: planEventId as string },
      });
      const followup = await prisma.generationEvent.findUniqueOrThrow({
        where: { id: followupEventId as string },
      });
      expect(plan.inputTokens).toBe(4321);
      // The old "latest event" heuristic wrote here instead.
      expect(followup.inputTokens).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('leaves an event that already carries a count alone', async () => {
    const { user, project, cleanup } = await fixture();
    try {
      const eventId = await logGenerationEvent({
        projectId: project.id,
        userId: user.id,
        kind: 'initial',
        isUrlClone: false,
        inputTokens: 100,
      });
      await attachGenerationInputTokens(eventId, 999);
      const row = await prisma.generationEvent.findUniqueOrThrow({
        where: { id: eventId as string },
      });
      // `logGenerationEvent` already priced this event at 100; a second write would make
      // `estimatedCost` and `inputTokens` describe different generations.
      expect(row.inputTokens).toBe(100);
    } finally {
      await cleanup();
    }
  });

  it('does nothing when the caller has no event id', async () => {
    await expect(attachGenerationInputTokens(null, 500)).resolves.toBeUndefined();
  });
});
