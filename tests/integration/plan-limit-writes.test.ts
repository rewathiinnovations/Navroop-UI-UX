import '../setup/env';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { testPrismaClient } from '../setup/db';
import { withLimit } from '@/lib/plans/limits';
import { createPlan } from '../factories/plan';
import { createUser } from '../factories/user';

/**
 * The two halves of plan administration that only real Postgres can settle.
 *
 * F-307 — every plan ceiling except credits was check-then-act. `checkLimit` issued a
 * plain `count()`, the caller's `create` was a separate statement, and two concurrent
 * creates at the ceiling both counted `limit - 1` and both inserted. `withLimit` re-counts
 * inside the transaction that performs the insert, serialized by a transaction-scoped
 * advisory lock keyed on the limit — so the proof is two overlapping reservations against
 * one database, not a fake.
 *
 * F-312 — `updatePlan` demoted the sibling default plans in one write and applied the
 * operator's payload in another. A failure in between moved the default while none of the
 * edit landed. The transaction is what makes that impossible, and rollback is a database
 * behaviour.
 */

const prisma = testPrismaClient();

const auth = vi.hoisted(() => ({ requireAdmin: vi.fn(), getSessionUser: vi.fn() }));

vi.mock('@/lib/auth', () => ({
  requireAdmin: auth.requireAdmin,
  getSessionUser: auth.getSessionUser,
}));
vi.mock('@/lib/audit/log', () => ({ writeAudit: vi.fn(async () => undefined) }));

const WS = 'ws_plan_limit_probe';

async function probeWorkspace(planId: string) {
  await prisma.workspace.upsert({
    where: { id: WS },
    create: { id: WS, planId, creditsUsed: 0, creditsPeriodStart: new Date(), storageBytes: 0 },
    update: { planId, creditsUsed: 0, storageBytes: 0 },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

describe('withLimit enforces a ceiling at the write (F-307)', () => {
  it('admits one of two overlapping reservations at the ceiling', async () => {
    // `storage` is the ceiling whose counter is this workspace's own row
    // (`Workspace.storageBytes`), so nothing outside this file can move the number of
    // free seats. `members` and `projects` are counted over the whole table by design —
    // `User` and `Project` have no workspaceId (F-320) — and the integration files run in
    // parallel workers against one database (F-606). A suite beside this one creating or
    // deleting an active user between the baseline count and the reservations changes the
    // ceiling itself, so both reservations are admitted or both refused and the failure
    // says nothing about F-307. `withLimit`'s advisory lock cannot prevent that: a plain
    // `createUser` never takes it. The lock, the re-count inside the transaction and the
    // rollback proved here are the same code for every kind — only the counter differs,
    // and this is the one that is ours alone.
    const plan = await createPlan(prisma, { storageBytesLimit: BigInt(1) });
    await probeWorkspace(plan.id);
    const created: string[] = [];

    // One byte free and each reservation claims one, so exactly one fits. The User row is
    // there so the rollback has something to leave behind, or not.
    const reserve = () =>
      withLimit(WS, 'storage', 1, async (tx) => {
        const user = await createUser(tx as unknown as Parameters<typeof createUser>[0]);
        created.push(user.id);
        await tx.workspace.update({ where: { id: WS }, data: { storageBytes: { increment: 1 } } });
        return user.id;
      });

    try {
      const results = await Promise.all([reserve(), reserve()]);

      const admitted = results.filter((result) => result.ok);
      const refused = results.filter((result) => !result.ok);
      expect(admitted).toHaveLength(1);
      expect(refused).toHaveLength(1);
      // The refusal is the plan's own denial message, not a database error.
      expect(refused[0].ok === false && refused[0].reason).toBe('storage');

      // And the refused reservation left nothing behind: its insert rolled back with it,
      // so one of the two User rows never existed and the counter moved exactly once.
      expect(await prisma.user.count({ where: { id: { in: created } } })).toBe(1);
      const workspace = await prisma.workspace.findUnique({ where: { id: WS } });
      expect(workspace?.storageBytes).toBe(1);
    } finally {
      await prisma.user.deleteMany({ where: { id: { in: created } } });
      await prisma.plan.delete({ where: { id: plan.id } });
    }
  });

  it('refuses a members reservation at a spent ceiling without running the write', async () => {
    // The members ceiling is the global `User.isActive` count (F-320), so no test can pin
    // how many seats are free. A ceiling of zero is spent whatever that count is, which
    // covers the global branch and its denial reason deterministically — and the contract
    // that matters on a refusal is that the caller's write never ran at all.
    const plan = await createPlan(prisma, { maxMembers: 0 });
    await probeWorkspace(plan.id);
    let ran = false;

    try {
      const result = await withLimit(WS, 'members', 1, async () => {
        ran = true;
        return 'unreachable';
      });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toBe('members');
      expect(ran).toBe(false);
    } finally {
      await prisma.plan.delete({ where: { id: plan.id } });
    }
  });

  it('passes the created row back to the caller', async () => {
    const plan = await createPlan(prisma, { maxMembers: -1 });
    await probeWorkspace(plan.id);
    try {
      const result = await withLimit(WS, 'members', 1, (tx) =>
        createUser(tx as unknown as Parameters<typeof createUser>[0]),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unlimited plan refused a reservation');
      expect(result.data.isActive).toBe(true);
      await prisma.user.delete({ where: { id: result.data.id } });
    } finally {
      await prisma.plan.delete({ where: { id: plan.id } });
    }
  });
});

describe('updatePlan is one transaction (F-312)', () => {
  it('leaves exactly one default plan when the edit fails mid-transaction', async () => {
    const currentDefault = await prisma.plan.findFirst({ where: { isDefault: true } });
    const incumbent = currentDefault ?? (await createPlan(prisma, { isDefault: true }));
    const challenger = await createPlan(prisma, { isDefault: false });
    const admin = await createUser(prisma, { role: 'ADMIN' });
    auth.requireAdmin.mockResolvedValue({ user: { id: admin.id, email: admin.email } });

    // Dynamic, not static: the `@/lib/auth` mock above has to be registered before the
    // action module evaluates its own imports.
    const { updatePlan } = await import('@/lib/plans/actions');

    try {
      // `storageBytesLimit` reaches `BigInt(...)` inside the transaction callback, and the
      // admin form supplies it as a string — so a non-numeric value is a real failure
      // raised after the sibling demotion has already been issued.
      await expect(
        updatePlan(challenger.id, { isDefault: true, storageBytesLimit: 'not-a-number' }),
      ).rejects.toThrow();

      const defaults = await prisma.plan.findMany({ where: { isDefault: true } });
      expect(defaults).toHaveLength(1);
      // The incumbent kept the default: the demotion rolled back with the failed edit.
      expect(defaults[0].id).toBe(incumbent.id);
    } finally {
      await prisma.plan.delete({ where: { id: challenger.id } });
      if (!currentDefault) await prisma.plan.delete({ where: { id: incumbent.id } });
      await prisma.user.delete({ where: { id: admin.id } });
    }
  });

  it('promotes exactly one default plan on a successful edit', async () => {
    const currentDefault = await prisma.plan.findFirst({ where: { isDefault: true } });
    const incumbent = currentDefault ?? (await createPlan(prisma, { isDefault: true }));
    const challenger = await createPlan(prisma, { isDefault: false, isActive: false });
    const admin = await createUser(prisma, { role: 'ADMIN' });
    auth.requireAdmin.mockResolvedValue({ user: { id: admin.id, email: admin.email } });

    const { updatePlan } = await import('@/lib/plans/actions');

    try {
      const result = await updatePlan(challenger.id, { isDefault: true, monthlyCredits: 777 });
      expect(result.ok).toBe(true);
      // The response is the stored row, not an echo of the input: a caller that echoed
      // reported the seeded default for every cap the admin had not touched.
      if (!result.ok) throw new Error(result.error);
      expect(result.data.monthlyCredits).toBe(777);
      // Promoting a plan activates it — `getEffectivePlan` falls back to the default with
      // no `isActive` filter, so an inactive default is a plan nothing can be measured by.
      expect(result.data.isActive).toBe(true);

      const defaults = await prisma.plan.findMany({ where: { isDefault: true } });
      expect(defaults.map((row) => row.id)).toEqual([challenger.id]);
    } finally {
      await prisma.plan.update({ where: { id: incumbent.id }, data: { isDefault: true } });
      await prisma.plan.delete({ where: { id: challenger.id } });
      if (!currentDefault) await prisma.plan.delete({ where: { id: incumbent.id } });
      await prisma.user.delete({ where: { id: admin.id } });
    }
  });
});
