import '../setup/env';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { testPrismaClient } from '../setup/db';
import {
  claimCreditPeriodRoll,
  consumeCredits,
  rollCreditPeriodIfNeeded,
} from '@/lib/plans/limits';
import { ensureDefaultPlan } from '../factories/plan';
import { createUser } from '../factories/user';

/**
 * The credit period roll against real Postgres (F-305).
 *
 * The roll used to read the workspace, decide in application code that the window had
 * elapsed, and then issue an unconditional `UPDATE … SET "creditsUsed" = 0` keyed only on
 * the row id. Two requests crossing the month boundary at once both read the old
 * `creditsPeriodStart` and both decided to roll; A's roll committed, A's debit set
 * `creditsUsed = 1`, and B's roll — already past its own check — then zeroed it. The
 * charge was lost, the `CreditLedger` row survived, and `getUsageBreakdown` absorbed the
 * difference as `unattributed` instead of reporting it.
 *
 * The guard is `AND "creditsPeriodStart" = <the period the caller decided on>` and the
 * answer is the row count, so B's late roll matches nothing. That cannot be proven by a
 * fake: it is one statement's WHERE clause and Postgres' own row-level serialization.
 *
 * The workspace id is a probe row, not `WORKSPACE_ROW_ID`, so nothing here disturbs a
 * concurrently running suite (or a developer's dev server) that shares the test database.
 */

const prisma = testPrismaClient();

const WS = 'ws_credit_roll_probe';
const PERIOD_OLD = new Date('2026-06-01T00:00:00.000Z');
const PERIOD_NEW = new Date('2026-07-01T00:00:00.000Z');

async function resetProbe(overrides: { creditsPeriodStart?: Date; pauseReason?: string } = {}) {
  const fields = {
    storageBytes: 0,
    creditsUsed: 0,
    creditsPeriodStart: overrides.creditsPeriodStart ?? PERIOD_OLD,
    creditAlert80Sent: false,
    spendUsd: 0,
    spendAlert80Sent: false,
    generationPaused: overrides.pauseReason != null,
    pauseReason: overrides.pauseReason ?? null,
    planId: null,
  };
  await prisma.workspace.upsert({
    where: { id: WS },
    create: { id: WS, ...fields },
    update: fields,
  });
}

beforeEach(async () => {
  await prisma.creditLedger.deleteMany({ where: { workspaceId: WS } });
  await resetProbe();
});

afterAll(async () => {
  await prisma.creditLedger.deleteMany({ where: { workspaceId: WS } });
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

describe('credit period roll over Postgres', () => {
  it('rolls the period and zeroes the counters', async () => {
    await prisma.workspace.update({
      where: { id: WS },
      data: { creditsUsed: 7, creditAlert80Sent: true, spendUsd: 3, spendAlert80Sent: true },
    });

    expect(await claimCreditPeriodRoll(WS, PERIOD_OLD, PERIOD_NEW)).toBe(true);

    const row = await prisma.workspace.findUniqueOrThrow({ where: { id: WS } });
    expect(row.creditsUsed).toBe(0);
    expect(row.creditsPeriodStart.toISOString()).toBe(PERIOD_NEW.toISOString());
    expect(row.creditAlert80Sent).toBe(false);
    expect(Number(row.spendUsd)).toBe(0);
    expect(row.spendAlert80Sent).toBe(false);
  });

  it('does not erase a debit written by the request that rolled first', async () => {
    // Request A rolls.
    expect(await claimCreditPeriodRoll(WS, PERIOD_OLD, PERIOD_NEW)).toBe(true);
    // A's `consumeCredits` debits the fresh period.
    await prisma.workspace.update({ where: { id: WS }, data: { creditsUsed: 1 } });

    // Request B read the workspace before A's roll, so it is still holding PERIOD_OLD and
    // has already decided to roll. This is the exact write that used to zero A's charge.
    expect(await claimCreditPeriodRoll(WS, PERIOD_OLD, PERIOD_NEW)).toBe(false);

    const row = await prisma.workspace.findUniqueOrThrow({ where: { id: WS } });
    expect(row.creditsUsed).toBe(1);
    expect(row.creditsPeriodStart.toISOString()).toBe(PERIOD_NEW.toISOString());
  });

  it('lets exactly one of two simultaneous rolls through', async () => {
    const results = await Promise.all([
      claimCreditPeriodRoll(WS, PERIOD_OLD, PERIOD_NEW),
      claimCreditPeriodRoll(WS, PERIOD_OLD, PERIOD_NEW),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('clears a spend-limit pause on the roll and leaves any other pause alone', async () => {
    await resetProbe({ pauseReason: 'SPEND_LIMIT' });
    expect(await claimCreditPeriodRoll(WS, PERIOD_OLD, PERIOD_NEW)).toBe(true);
    const cleared = await prisma.workspace.findUniqueOrThrow({ where: { id: WS } });
    expect(cleared.generationPaused).toBe(false);
    expect(cleared.pauseReason).toBeNull();

    await resetProbe({ pauseReason: 'ADMIN' });
    expect(await claimCreditPeriodRoll(WS, PERIOD_OLD, PERIOD_NEW)).toBe(true);
    const kept = await prisma.workspace.findUniqueOrThrow({ where: { id: WS } });
    expect(kept.generationPaused).toBe(true);
    expect(kept.pauseReason).toBe('ADMIN');
  });

  it('reports the rolled period to its caller whether it won the race or not', async () => {
    const [first, second] = await Promise.all([
      rollCreditPeriodIfNeeded(WS),
      rollCreditPeriodIfNeeded(WS),
    ]);
    expect(first.creditsPeriodStart.toISOString()).toBe(second.creditsPeriodStart.toISOString());
    expect(first.creditsPeriodStart.getTime()).toBeGreaterThan(PERIOD_OLD.getTime());
  });
});

describe('two overlapping debits across the period boundary', () => {
  it('keeps the counter equal to the ledger', async () => {
    await ensureDefaultPlan(prisma);
    const user = await createUser(prisma);
    try {
      await Promise.all([
        consumeCredits(WS, user.id, 'generation'),
        consumeCredits(WS, user.id, 'generation'),
      ]);

      const row = await prisma.workspace.findUniqueOrThrow({ where: { id: WS } });
      const ledger = await prisma.creditLedger.aggregate({
        where: { workspaceId: WS },
        _sum: { credits: true },
      });
      expect(ledger._sum.credits).toBe(2);
      // The counter and the ledger are the two numbers `getUsageBreakdown` compares.
      // A lost roll made them disagree permanently.
      expect(row.creditsUsed).toBe(ledger._sum.credits);
    } finally {
      await prisma.creditLedger.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});
