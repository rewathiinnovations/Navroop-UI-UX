/**
 * Plan + credit limits: costs, period roll, check/consume, 402 English copy.
 * Run: pnpm exec tsx tests/plans-limits.test.ts
 */
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { testPrismaClient } from './setup/db.ts';
import {
  CREDIT_COSTS,
  checkCredits,
  checkLimit,
  consumeCredits,
  creditDenialMessage,
  getEffectivePlan,
  isUnlimited,
  rollCreditPeriodIfNeeded,
  shouldRollCreditPeriod,
} from '../lib/plans/limits.ts';
import { ensureDefaultPlan } from './factories/plan.ts';

config({ path: resolve(process.cwd(), '.env.local') });
config({ path: resolve(process.cwd(), '.env') });

const prisma = testPrismaClient();

let failed = 0;
let passed = 0;

function assert(cond: unknown, name: string) {
  if (cond) {
    passed += 1;
    console.log(`PASS  ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL  ${name}`);
}

assert(CREDIT_COSTS.generation === 1, 'generation costs 1');
assert(CREDIT_COSTS.image === 2, 'image costs 2');
assert(CREDIT_COSTS.import === 5, 'import costs 5');
assert(CREDIT_COSTS.audit === 1, 'audit costs 1');
assert(CREDIT_COSTS.evolution === 20, 'evolution costs 20');

assert(isUnlimited(-1), '-1 is unlimited');
assert(!isUnlimited(0), '0 is not unlimited');
assert(!isUnlimited(5), '5 is not unlimited');

assert(
  creditDenialMessage('workspace_exhausted') === "This month's credits are used up",
  'workspace exhausted English',
);
assert(
  creditDenialMessage('member_cap') ===
    'Your personal limit is used up — ask an admin to raise it',
  'member cap English',
);
assert(
  creditDenialMessage('paused') === 'An admin has paused generation',
  'paused English',
);

const now = new Date('2026-08-17T12:00:00.000Z');
assert(
  shouldRollCreditPeriod(new Date('2026-07-13T12:00:00.000Z'), now) === true,
  'rolls when period start is 35 days old',
);
assert(
  shouldRollCreditPeriod(new Date('2026-08-01T00:00:00.000Z'), now) === false,
  'does not roll inside the current month window',
);

const WS = 'ws_plans_limits_test';
const USER = 'user_plans_limits_test';

try {
  await prisma.creditLedger.deleteMany({ where: { workspaceId: WS } });
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.user.deleteMany({ where: { id: USER } });

  const free = await ensureDefaultPlan(prisma);
  assert(Boolean(free), 'default Free plan exists after seed/migrate');

  await prisma.user.create({
    data: {
      id: USER,
      email: 'plans-limits-test@navroop.local',
      name: 'Plans Test',
      passwordHash: 'x',
      role: 'MEMBER',
    },
  });

  await prisma.workspace.create({
    data: {
      id: WS,
      storageBytes: 0,
      creditsUsed: 2,
      creditsPeriodStart: new Date('2026-07-13T12:00:00.000Z'),
      creditAlert80Sent: true,
      generationPaused: false,
    },
  });

  const noPlan = await getEffectivePlan(WS);
  assert(noPlan.id === free.id, 'workspace with no planId falls back to isDefault');

  const rolled = await rollCreditPeriodIfNeeded(WS);
  assert(rolled.creditsUsed === 0, 'period roll resets creditsUsed');
  assert(rolled.creditAlert80Sent === false, 'period roll resets creditAlert80Sent');
  assert(rolled.creditsPeriodStart.getTime() > Date.parse('2026-07-13T12:00:00.000Z'), 'period start moves forward');

  await prisma.workspace.update({
    where: { id: WS },
    data: { creditsUsed: 0, generationPaused: true, memberMonthlyCreditCap: 1 },
  });

  const paused = await checkCredits(WS, USER, 'generation');
  assert(paused.ok === false && paused.reason === 'paused', 'paused blocks generation');
  assert(paused.message === creditDenialMessage('paused'), 'paused uses English message');

  for (const action of ['generation', 'image', 'import', 'audit', 'evolution'] as const) {
    const result = await checkCredits(WS, USER, action);
    assert(result.ok === false && result.reason === 'paused', `paused blocks ${action}`);
  }

  await prisma.workspace.update({
    where: { id: WS },
    data: { generationPaused: false, creditsUsed: free.monthlyCredits },
  });
  const exhausted = await checkCredits(WS, USER, 'generation');
  assert(exhausted.ok === false && exhausted.reason === 'workspace_exhausted', 'workspace credits block before work');
  assert(exhausted.used === free.monthlyCredits, 'exhausted reports used');
  assert(exhausted.limit === free.monthlyCredits, 'exhausted reports limit');

  await prisma.workspace.update({
    where: { id: WS },
    data: { creditsUsed: 0, memberMonthlyCreditCap: 1 },
  });
  const cap = await checkCredits(WS, USER, 'image');
  assert(cap.ok === false && cap.reason === 'member_cap', 'member cap blocks when cost exceeds cap');

  await prisma.workspace.update({
    where: { id: WS },
    data: { memberMonthlyCreditCap: null, creditsUsed: 0 },
  });
  const ok = await checkCredits(WS, USER, 'generation');
  assert(ok.ok === true && ok.cost === 1, 'checkCredits allows generation when under limit');

  const before = await prisma.workspace.findUniqueOrThrow({ where: { id: WS } });
  await consumeCredits(WS, USER, 'generation');
  const after = await prisma.workspace.findUniqueOrThrow({ where: { id: WS } });
  assert(after.creditsUsed === before.creditsUsed + 1, 'consumeCredits increments creditsUsed');
  const ledger = await prisma.creditLedger.findFirst({
    where: { workspaceId: WS, userId: USER, action: 'generation' },
  });
  assert(ledger?.credits === 1, 'consumeCredits writes a ledger row');

  const projects = await checkLimit(WS, 'projects');
  assert(projects.limit === free.maxProjects, 'checkLimit projects uses effective plan');
  assert(isUnlimited(-1) && (await checkLimit(WS, 'previewSites')).limit === free.maxPreviewSites, 'preview limit from plan');

  const storage = await checkLimit(WS, 'storage');
  assert(storage.limit === Number(free.storageBytesLimit), 'storage limit from plan BigInt');
} catch (error) {
  failed += 1;
  console.error('FAIL  db assertions', error);
} finally {
  await prisma.creditLedger.deleteMany({ where: { workspaceId: WS } });
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.$disconnect();
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
