import '../setup/env';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { testPrismaClient } from '../setup/db';
import { createPlan, listPlans, updatePlan } from '@/lib/plans/actions';

/**
 * The three per-job caps used to be written by a follow-up `$executeRaw` because the
 * generated client predated the columns. Two defects came out of that:
 *
 * - `createPlan`'s raw statement carried a trailing comma before its WHERE, so every
 *   create inserted the row and then threw `syntax error at or near "WHERE"`. The route
 *   has no try/catch, so Admin -> Plans -> Create plan answered 500 while the plan sat
 *   in the database, visible only after a refresh. No test noticed because nothing
 *   exercised `createPlan` end to end.
 * - `updatePlan` echoed `input.maxTokensPerJob` back to the client instead of the row it
 *   had just written. Those are `undefined` whenever the admin edited a different field,
 *   and the mapper turned `undefined` into the hardcoded defaults — so editing Credits
 *   told PlansAdmin that Tokens/job was 120000 when the row said 200000, and the next
 *   edit was compared against that phantom baseline.
 *
 * Both are now ordinary Prisma fields, and this suite reads the row back to prove it.
 */

const prisma = testPrismaClient();

const ADMIN = { id: 'user_plan_caps_admin', email: 'plan-caps@navroop.local', role: 'ADMIN' };

vi.mock('@/lib/auth', () => ({
  requireAdmin: async () => ({ user: ADMIN, error: null, status: 200 }),
  getSessionUser: async () => ADMIN,
}));
vi.mock('@/lib/audit/log', () => ({ writeAudit: async () => undefined }));

const createdIds: string[] = [];

async function create(key: string, input: Record<string, unknown> = {}) {
  const result = await createPlan({
    key,
    name: key,
    monthlyCredits: 100,
    maxProjects: 5,
    maxLiveSites: 1,
    maxPreviewSites: 3,
    maxMembers: 2,
    checkpointRetentionDays: 7,
    storageBytesLimit: '524288000',
    ...input,
  });
  if (result.ok) createdIds.push(result.data.id);
  return result;
}

afterEach(async () => {
  if (createdIds.length === 0) return;
  await prisma.plan.deleteMany({ where: { id: { in: createdIds.splice(0) } } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('admin plan job caps', () => {
  it('creates a plan in one statement and reports the caps it stored', async () => {
    const result = await create(`caps-create-${Date.now()}`, { maxTokensPerJob: 200000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.maxTokensPerJob).toBe(200000);
    expect(result.data.maxFilesPerJob).toBe(60);
    expect(result.data.maxOutputBytesPerJob).toBe(2000000);

    const row = await prisma.plan.findUniqueOrThrow({ where: { id: result.data.id } });
    expect(row.maxTokensPerJob).toBe(200000);
    expect(row.maxFilesPerJob).toBe(60);
    expect(row.maxOutputBytesPerJob).toBe(2000000);
  });

  it('editing an unrelated field leaves the caps alone in the row and the response', async () => {
    const created = await create(`caps-update-${Date.now()}`, { maxTokensPerJob: 200000 });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const updated = await updatePlan(created.data.id, { monthlyCredits: 250 });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.data.monthlyCredits).toBe(250);
    expect(updated.data.maxTokensPerJob).toBe(200000);

    const row = await prisma.plan.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(row.maxTokensPerJob).toBe(200000);

    const listed = await listPlans();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const fromList = listed.data.plans.find((plan) => plan.id === created.data.id);
    expect(fromList?.maxTokensPerJob).toBe(200000);
  });

  it('writes a cap the admin does edit', async () => {
    const created = await create(`caps-edit-${Date.now()}`);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data.maxFilesPerJob).toBe(60);

    const updated = await updatePlan(created.data.id, { maxFilesPerJob: 12 });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.data.maxFilesPerJob).toBe(12);
    const row = await prisma.plan.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(row.maxFilesPerJob).toBe(12);
  });
});
