import '../setup/env';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { testPrismaClient } from '../setup/db';
import { maybeSettleFollowups, recordCodeAuditSignals } from '@/lib/signals/collect';
import { a11yScoreFromAxe, typeSafetyScore } from '@/lib/signals/score';

/**
 * The collector rewrite against a real Postgres.
 *
 * Two things a mocked Prisma cannot prove. The once-per-audit guard is now a
 * JSON path filter (`rawValue.path = ['codeAuditId']`) instead of loading every
 * signal row for the project and comparing in JavaScript (F-817) — if that
 * filter is not valid for this column, a mock would still be green while
 * production duplicated every signal. And the settle pass now inserts the
 * batch with `createMany`, so each row's `promptVersion` has to survive a path
 * that no longer goes through `writeSignal` (F-815 must keep holding).
 */

const prisma = testPrismaClient();

const USER = 'user_signal_collectors';
const PROJECT = 'proj_signal_collectors';
const V1 = '1'.repeat(64);
const V2 = '2'.repeat(64);

async function seed() {
  await prisma.user.upsert({
    where: { id: USER },
    create: {
      id: USER,
      email: 'signal-collectors@example.com',
      name: 'Signal collectors',
      role: 'MEMBER',
      passwordHash: 'not-a-real-hash',
    },
    update: {},
  });
  await prisma.project.upsert({
    where: { id: PROJECT },
    create: {
      id: PROJECT,
      name: 'Signal collectors',
      ownerId: USER,
      initialPrompt: 'collector probe',
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

async function signals(kind: string) {
  return prisma.qualitySignal.findMany({
    where: { projectId: PROJECT, kind },
    orderBy: { createdAt: 'asc' },
    select: { value: true, rawValue: true, promptVersion: true, generationEventId: true },
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

describe('code audit signals', () => {
  it('records one row per audit, and the second run of the same audit adds nothing', async () => {
    await addBuild(V1, new Date('2026-08-01T00:00:00Z'));

    await recordCodeAuditSignals({
      projectId: PROJECT,
      codeAuditId: 'audit-a',
      axeViolations: [{ impact: 'critical' }, { impact: 'minor' }],
      tsErrors: 2,
    });
    await recordCodeAuditSignals({
      projectId: PROJECT,
      codeAuditId: 'audit-a',
      axeViolations: [{ impact: 'critical' }, { impact: 'minor' }],
      tsErrors: 2,
    });

    const a11y = await signals('a11y_score');
    expect(a11y).toHaveLength(1);
    expect(a11y[0].value).toBeCloseTo(
      a11yScoreFromAxe([{ impact: 'critical' }, { impact: 'minor' }]),
      10,
    );
    expect(a11y[0].promptVersion).toBe(V1);
    expect(await signals('type_safety')).toHaveLength(1);
    // The build never ran, so nothing claims it succeeded.
    expect(await signals('build_success')).toHaveLength(0);
  });

  it('records a second row for the next audit', async () => {
    await addBuild(V1, new Date('2026-08-01T00:00:00Z'));
    await recordCodeAuditSignals({ projectId: PROJECT, codeAuditId: 'audit-a', tsErrors: 0 });
    await recordCodeAuditSignals({ projectId: PROJECT, codeAuditId: 'audit-b', tsErrors: 5 });

    const rows = await signals('type_safety');
    expect(rows).toHaveLength(2);
    expect(rows[0].value).toBe(1);
    // `value` is DOUBLE PRECISION, but the round trip through the driver's text
    // encoding drops the last digit (0.1666666666666667 back from
    // 0.16666666666666666), so scores are compared with tolerance, never `toBe`.
    expect(rows[1].value).toBeCloseTo(typeSafetyScore(5), 12);
  });
});

describe('the settle pass', () => {
  it('settles every generation in one batch, each stamped with its own version', async () => {
    const first = await addBuild(V1, new Date('2026-08-01T00:00:00Z'));
    const second = await addBuild(V2, new Date('2026-08-01T01:00:00Z'));
    const third = await addBuild(V2, new Date('2026-08-01T02:00:00Z'));

    await maybeSettleFollowups(PROJECT, new Date('2026-08-01T04:00:00Z'));

    const reverts = await signals('revert_rate');
    expect(reverts).toHaveLength(3);
    expect(reverts.every((row) => row.value === 1)).toBe(true);
    const versionByEvent = Object.fromEntries(
      reverts.map((row) => [row.generationEventId, row.promptVersion]),
    );
    expect(versionByEvent[first.id]).toBe(V1);
    expect(versionByEvent[second.id]).toBe(V2);
    expect(versionByEvent[third.id]).toBe(V2);

    const settled = await signals('followups_to_settle');
    expect(settled).toHaveLength(1);
    expect(settled[0].promptVersion).toBe(V2);
  });

  it('does not re-settle a generation that already carries a revert signal', async () => {
    const only = await addBuild(V1, new Date('2026-08-01T00:00:00Z'));
    await prisma.qualitySignal.create({
      data: {
        projectId: PROJECT,
        generationEventId: only.id,
        kind: 'revert_rate',
        value: 0,
        rawValue: { reverted: true },
        promptVersion: V1,
      },
    });

    await maybeSettleFollowups(PROJECT, new Date('2026-08-01T04:00:00Z'));

    const reverts = await signals('revert_rate');
    expect(reverts).toHaveLength(1);
    expect(reverts[0].value).toBe(0);
  });
});
