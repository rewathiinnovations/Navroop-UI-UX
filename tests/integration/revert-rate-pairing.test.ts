import '../setup/env';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { testPrismaClient } from '../setup/db';
import {
  maybeSettleFollowups,
  recordGenerationKept,
  recordRevertRate,
} from '@/lib/signals/collect';

/**
 * F-818 — `revert_rate` recorded the failure on every restore immediately but the
 * compensating success only from `maybeSettleFollowups`, and only 30 minutes after a
 * project's last build. A project still being iterated on never reaches that, so the
 * projects generating the most signal contributed all zeros and no ones: the aggregate read
 * as though every generation had been rejected, biased against whichever prompt version
 * happened to be active during heavy use.
 *
 * Second half of the same finding: the settle scan was bounded by
 * `createdAt: { gt: lastSettle.createdAt }`, so an event written in the same millisecond as
 * the settle row was skipped permanently — never counted, never paired.
 */

const prisma = testPrismaClient();

const OWNER = 'user_revert_rate_owner';
const PROJECT = 'proj_revert_rate';

async function makeEvent(createdAt: Date, kind: 'initial' | 'followup' = 'followup') {
  return prisma.generationEvent.create({
    data: { projectId: PROJECT, userId: OWNER, kind, estimatedCost: 0, createdAt },
    select: { id: true, createdAt: true },
  });
}

async function revertRows() {
  return prisma.qualitySignal.findMany({
    where: { projectId: PROJECT, kind: 'revert_rate' },
    orderBy: { createdAt: 'asc' },
    select: { generationEventId: true, value: true, rawValue: true },
  });
}

beforeEach(async () => {
  await prisma.user.upsert({
    where: { id: OWNER },
    create: {
      id: OWNER,
      email: 'revert-rate@example.com',
      name: 'Revert Rate Owner',
      role: 'MEMBER',
      passwordHash: 'not-a-real-hash',
    },
    update: {},
  });
  await prisma.project.deleteMany({ where: { id: PROJECT } });
  await prisma.project.create({
    data: {
      id: PROJECT,
      name: 'Revert rate probe',
      initialPrompt: 'A landing page under active iteration',
      ownerId: OWNER,
    },
  });
});

afterAll(async () => {
  await prisma.project.deleteMany({ where: { id: PROJECT } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: OWNER } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe('revert_rate is paired at generation time, not only after a 30-minute settle', () => {
  it('records the kept generation immediately', async () => {
    const event = await makeEvent(new Date());

    await recordGenerationKept(PROJECT);

    const rows = await revertRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].generationEventId).toBe(event.id);
    expect(rows[0].value).toBe(1);
    expect(rows[0].rawValue).toMatchObject({ reverted: false, kept: true });
  });

  it('a project under active iteration is not all zeros', async () => {
    // Three builds minutes apart — the shape `maybeSettleFollowups` never settles, because
    // the newest is always inside the 30-minute window.
    for (const minutesAgo of [10, 5, 1]) {
      await makeEvent(new Date(Date.now() - minutesAgo * 60_000));
      await recordGenerationKept(PROJECT);
    }
    // The settle sweep still declines, which is what used to leave the population empty.
    expect(await maybeSettleFollowups(PROJECT)).toBeNull();

    const rows = await revertRows();
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.value)).toEqual([1, 1, 1]);
  });

  it('a restore flips the kept row to a revert instead of adding a second row', async () => {
    const event = await makeEvent(new Date());
    await recordGenerationKept(PROJECT);

    await recordRevertRate(PROJECT);

    const rows = await revertRows();
    expect(rows, 'the restore wrote a second row instead of updating').toHaveLength(1);
    expect(rows[0].generationEventId).toBe(event.id);
    expect(rows[0].value).toBe(0);
    expect(rows[0].rawValue).toMatchObject({ reverted: true });
  });

  it('is idempotent, so a retried persist does not double-count', async () => {
    await makeEvent(new Date());

    await recordGenerationKept(PROJECT);
    await recordGenerationKept(PROJECT);

    expect(await revertRows()).toHaveLength(1);
  });

  it('does not overwrite a revert already recorded for the same generation', async () => {
    await makeEvent(new Date());
    await recordRevertRate(PROJECT);

    await recordGenerationKept(PROJECT);

    const rows = await revertRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].value, 'the kept write resurrected a rejected generation').toBe(0);
  });
});

describe('the settle cursor does not drop an event on its boundary', () => {
  it('counts an event written in the same millisecond as the previous settle row', async () => {
    const settledAt = new Date(Date.now() - 90 * 60_000);
    const counted = await makeEvent(new Date(settledAt.getTime() - 60_000));
    // The previous settle, recording the event it counted — this is the cursor.
    await prisma.qualitySignal.create({
      data: {
        projectId: PROJECT,
        generationEventId: counted.id,
        kind: 'followups_to_settle',
        value: 1,
        rawValue: { generations: 1, eventIds: [counted.id] },
        promptVersion: 'test-version',
        createdAt: settledAt,
      },
    });
    // Written to the same millisecond as the settle row: `gt` skipped this forever.
    const boundary = await makeEvent(settledAt);

    const settled = await maybeSettleFollowups(PROJECT);
    expect(settled, 'the boundary event was not counted, so no settle happened').not.toBeNull();

    const rows = await revertRows();
    expect(rows.map((row) => row.generationEventId)).toEqual([boundary.id]);
    expect(rows[0].value).toBe(1);
  });

  // Control: re-admitting the boundary must not re-count what the previous settle already
  // recorded, which is what the `eventIds` tiebreak is for.
  it('control: the already-counted event on the boundary is not counted twice', async () => {
    const settledAt = new Date(Date.now() - 90 * 60_000);
    const counted = await makeEvent(settledAt);
    await prisma.qualitySignal.create({
      data: {
        projectId: PROJECT,
        generationEventId: counted.id,
        kind: 'followups_to_settle',
        value: 1,
        rawValue: { generations: 1, eventIds: [counted.id] },
        promptVersion: 'test-version',
        createdAt: settledAt,
      },
    });

    expect(await maybeSettleFollowups(PROJECT)).toBeNull();
    expect(await revertRows()).toEqual([]);
  });
});
