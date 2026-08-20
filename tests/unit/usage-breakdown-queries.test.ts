import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The usage breakdown must cost a bounded number of queries and a bounded amount of
 * memory, whatever a month of activity looks like (F-311).
 *
 * It used to load every `CreditLedger` row of the period with `include: { user: true }`
 * and reduce them in application code. One row exists per credit-consuming action, so a
 * busy month is thousands of rows, the joined `user` object was duplicated onto every one
 * of them, and any signed-in member can call this as often as they like. Postgres answers
 * the same question in a handful of grouped rows.
 *
 * The assertion is the call count and the absence of a row-level read, not wall-clock:
 * a timing assertion would pass on a fast machine with the defect still in place.
 */

const db = vi.hoisted(() => ({
  groupBy: vi.fn(),
  findMany: vi.fn(),
  ledgerFindMany: vi.fn(),
  aggregate: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    creditLedger: {
      groupBy: db.groupBy,
      findMany: db.ledgerFindMany,
      aggregate: db.aggregate,
    },
    user: { findMany: db.findMany },
  },
}));

vi.mock('@/lib/auth', () => ({
  getSessionUser: vi.fn(async () => ({ id: 'u1', email: 'a@example.com', role: 'ADMIN' })),
  requireAdmin: vi.fn(),
}));

vi.mock('@/lib/audit/log', () => ({ writeAudit: vi.fn() }));

vi.mock('@/lib/plans/limits', () => ({
  ensureWorkspace: vi.fn(),
  getEffectivePlan: vi.fn(async () => ({ monthlyCredits: 1000, storageBytesLimit: 1n })),
  rollCreditPeriodIfNeeded: vi.fn(async () => ({
    id: 'default',
    creditsUsed: 12,
    creditsPeriodStart: new Date('2026-08-01T00:00:00.000Z'),
    storageBytes: 0,
    generationPaused: false,
  })),
}));

function memberGroups(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    userId: `u${index}`,
    action: 'generation',
    _sum: { credits: 1 },
  }));
}

function users(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `u${index}`,
    name: `Member ${index}`,
    email: `m${index}@example.com`,
  }));
}

async function runBreakdown(members: number) {
  db.groupBy.mockReset();
  db.findMany.mockReset();
  db.ledgerFindMany.mockReset();
  db.aggregate.mockReset();
  db.groupBy
    .mockResolvedValueOnce([{ action: 'generation', _sum: { credits: members } }])
    .mockResolvedValueOnce(memberGroups(members));
  db.findMany.mockResolvedValue(users(members));

  const { getUsageBreakdown } = await import('@/lib/plans/actions');
  const result = await getUsageBreakdown();
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getUsageBreakdown', () => {
  it('answers with grouped aggregates and never reads ledger rows', async () => {
    const data = await runBreakdown(2);

    expect(db.ledgerFindMany).not.toHaveBeenCalled();
    // The grouped sums already are the total; the extra `aggregate` scanned the period a
    // second time for a number it had.
    expect(db.aggregate).not.toHaveBeenCalled();
    expect(data.byAction).toEqual({ generation: 2 });
    expect(data.members).toHaveLength(2);
    expect(data.workspaceTotal).toBe(2);
  });

  it('costs the same number of queries for two members as for two hundred', async () => {
    await runBreakdown(2);
    const small = db.groupBy.mock.calls.length + db.findMany.mock.calls.length;

    await runBreakdown(200);
    const large = db.groupBy.mock.calls.length + db.findMany.mock.calls.length;

    expect(small).toBe(3);
    expect(large).toBe(small);
  });

  it('reports the gap between the workspace counter and the ledger', async () => {
    const data = await runBreakdown(2);
    // The meter is `Workspace.creditsUsed` (12 here) and the breakdown is the ledger (2).
    // They diverge legitimately when a deleted user's rows cascade away; hiding the
    // difference is how the two numbers came to disagree silently.
    expect(data.unattributed).toBe(10);
  });
});
