/**
 * Audit log + database invariants.
 * Run: pnpm exec tsx tests/audit-invariants.test.ts
 */
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { Prisma } from '../generated/prisma/index.js';
import { testPrismaClient } from './setup/db.ts';
import { hashPassword } from '../lib/password.ts';
import { REQUIRED_AUDIT_ACTIONS, writeAudit } from '../lib/audit/log.ts';
import { consumeCredits } from '../lib/plans/limits.ts';
import { createOrReuseJob } from '../lib/jobs/lifecycle.ts';
import { WORKSPACE_ROW_ID } from '../lib/storage/usage.ts';
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

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const actorEmail = `audit-actor-${suffix}@example.com`;

const requiredActions = [
  'project.create',
  'project.soft_delete',
  'project.restore',
  'project.hard_purge',
  'member.invite',
  'member.role_change',
  'member.deactivate',
  'member.remove',
  'plan.assign',
  'plan.limits_edit',
  'integration.connect',
  'integration.disconnect',
  'deployment.create',
  'deployment.stop',
  'deployment.delete',
  'domain.add',
  'domain.remove',
  'api_key.add',
  'api_key.rotate',
  'api_key.delete',
  'workspace.generation_paused',
  'lock.force_release',
  'job.force_abandon',
  'password_reset.requested',
  'password_reset.completed',
  'template.create',
  'template.delete',
] as const;

assert(
  requiredActions.every((action) => REQUIRED_AUDIT_ACTIONS.includes(action)),
  'REQUIRED_AUDIT_ACTIONS lists every specified action',
);

try {
  const passwordHash = await hashPassword('audit-invariants-test');
  const actor = await prisma.user.create({
    data: {
      email: actorEmail,
      name: 'Audit Actor',
      passwordHash,
      role: 'ADMIN',
    },
  });

  for (const action of requiredActions) {
    await writeAudit({
      actorId: actor.id,
      actorEmail: actor.email,
      action,
      targetType: 'test',
      targetId: `target-${action}`,
      after: {
        apiKey: 'sk-live-SHOULD-NOT-APPEAR',
        password: 'hunter2',
        token: 'reset-token-secret',
        secret: 'super-secret',
        changed: true,
      },
    });
  }

  const rows = await prisma.$queryRaw<
    Array<{ action: string; actorEmail: string; after: unknown }>
  >`
    SELECT action, "actorEmail", after
    FROM "AuditLog"
    WHERE "actorId" = ${actor.id}
  `;

  for (const action of requiredActions) {
    const row = rows.find((item) => item.action === action);
    assert(Boolean(row), `${action} writes an audit entry`);
    assert(row?.actorEmail === actor.email, `${action} records the correct actor`);
    const serialized = JSON.stringify(row?.after ?? {});
    assert(
      !/sk-live-SHOULD-NOT-APPEAR|hunter2|reset-token-secret|super-secret/i.test(serialized),
      `${action} audit entry contains no secret`,
    );
  }

  let operationReached = false;
  const operation = async () => {
    await writeAudit(
      {
        actorId: actor.id,
        actorEmail: actor.email,
        action: 'project.create',
        after: { ok: true },
      },
      {
        persist: async () => {
          throw new Error('induced audit failure');
        },
      },
    );
    operationReached = true;
    return 'ok';
  };
  const opResult = await operation();
  assert(opResult === 'ok', 'induced audit write failure does not fail the operation');
  assert(operationReached, 'operation continues after audit persist throws');

  const adminA = await prisma.user.create({
    data: {
      email: `last-admin-a-${suffix}@example.com`,
      name: 'Last Admin A',
      passwordHash,
      role: 'ADMIN',
    },
  });
  const adminB = await prisma.user.create({
    data: {
      email: `last-admin-b-${suffix}@example.com`,
      name: 'Last Admin B',
      passwordHash,
      role: 'ADMIN',
    },
  });
  const otherAdmins = await prisma.user.findMany({
    where: {
      role: 'ADMIN',
      isActive: true,
      id: { notIn: [adminA.id, adminB.id] },
    },
    select: { id: true },
  });
  if (otherAdmins.length > 0) {
    await prisma.user.updateMany({
      where: { id: { in: otherAdmins.map((row) => row.id) } },
      data: { isActive: false },
    });
  }
  try {
    const results = await Promise.allSettled([
      prisma.user.update({ where: { id: adminA.id }, data: { role: 'MEMBER' } }),
      prisma.user.update({ where: { id: adminB.id }, data: { role: 'MEMBER' } }),
    ]);
    const succeeded = results.filter((row) => row.status === 'fulfilled').length;
    const remaining = await prisma.user.count({
      where: { role: 'ADMIN', isActive: true, id: { in: [adminA.id, adminB.id] } },
    });
    assert(succeeded === 1, 'two concurrent last-admin demotions: exactly one succeeds');
    assert(remaining === 1, 'two concurrent last-admin demotions leave one active admin');
  } finally {
    if (otherAdmins.length > 0) {
      await prisma.user.updateMany({
        where: { id: { in: otherAdmins.map((row) => row.id) } },
        data: { isActive: true },
      });
    }
  }

  const owner = await prisma.user.create({
    data: {
      email: `job-owner-${suffix}@example.com`,
      name: 'Job Owner',
      passwordHash,
      role: 'MEMBER',
    },
  });
  const project = await prisma.project.create({
    data: {
      name: `Invariant ${suffix}`,
      initialPrompt: 'invariant test',
      ownerId: owner.id,
    },
  });
  await prisma.workspace.upsert({
    where: { id: WORKSPACE_ROW_ID },
    create: { id: WORKSPACE_ROW_ID, storageBytes: 0 },
    update: {},
  });

  const jobResults = await Promise.allSettled([
    createOrReuseJob({
      projectId: project.id,
      workspaceId: WORKSPACE_ROW_ID,
      userId: owner.id,
      kind: 'BUILD',
      inputPrompt: 'first',
    }),
    createOrReuseJob({
      projectId: project.id,
      workspaceId: WORKSPACE_ROW_ID,
      userId: owner.id,
      kind: 'FOLLOWUP',
      inputPrompt: 'second',
    }),
  ]);
  const jobOk = jobResults.filter((row) => row.status === 'fulfilled').length;
  const activeJobs = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM "GenerationJob"
    WHERE "projectId" = ${project.id}
      AND status IN ('QUEUED', 'RUNNING')
  `;
  assert(jobOk >= 1, 'concurrent job starts do not both crash');
  assert(Number(activeJobs[0]?.count ?? 0) === 1, 'two concurrent job starts leave one active job');

  const creditWs = `ws_audit_credits_${suffix}`;
  const creditUserA = `user_credit_a_${suffix}`;
  const creditUserB = `user_credit_b_${suffix}`;
  const free = await ensureDefaultPlan(prisma);
  assert(Boolean(free), 'default plan exists for credit race');

  await prisma.user.create({
    data: { id: creditUserA, email: `credit-a-${suffix}@example.com`, name: 'CA', passwordHash, role: 'MEMBER' },
  });
  await prisma.user.create({
    data: { id: creditUserB, email: `credit-b-${suffix}@example.com`, name: 'CB', passwordHash, role: 'MEMBER' },
  });
  await prisma.workspace.create({
    data: {
      id: creditWs,
      storageBytes: 0,
      planId: free.id,
      creditsUsed: free.monthlyCredits - 1,
      generationPaused: false,
    },
  });
  const creditResults = await Promise.allSettled([
    consumeCredits(creditWs, creditUserA, 'generation'),
    consumeCredits(creditWs, creditUserB, 'generation'),
  ]);
  const charged = creditResults.filter((row) => row.status === 'fulfilled').length;
  const refused = creditResults.filter((row) => row.status === 'rejected').length;
  const afterWs = await prisma.workspace.findUniqueOrThrow({ where: { id: creditWs } });
  const ledgerCount = await prisma.creditLedger.count({ where: { workspaceId: creditWs } });
  assert(charged === 1, 'two concurrent consumes with 1 credit left: exactly one charged');
  assert(refused === 1, 'two concurrent consumes with 1 credit left: the other is refused');
  assert(afterWs.creditsUsed === free.monthlyCredits, 'creditsUsed stops at the plan limit');
  assert(ledgerCount === 1, 'only one credit ledger row is written');

  const server = await prisma.coolifyServer.create({
    data: {
      name: `inv-server-${suffix}`,
      apiUrl: 'https://coolify.example.test',
      apiToken: 'token',
      serverIp: '10.0.0.1',
      projectUuid: 'uuid',
    },
  });
  await prisma.deployment.create({
    data: {
      projectId: project.id,
      workspaceId: WORKSPACE_ROW_ID,
      serverId: server.id,
      kind: 'LIVE',
      status: 'LIVE',
      slug: `inv-${suffix}`.slice(0, 40),
      publishedById: owner.id,
    },
  });
  let deleteRefused = false;
  try {
    await prisma.project.delete({ where: { id: project.id } });
  } catch (error) {
    deleteRefused =
      (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') ||
      /foreign key|restrict/i.test(error instanceof Error ? error.message : String(error));
  }
  const stillThere = await prisma.project.findUnique({ where: { id: project.id }, select: { id: true } });
  assert(deleteRefused, 'hard-delete project with Deployment is refused by FK');
  assert(Boolean(stillThere), 'project row remains when a deployment exists');

  await prisma.creditLedger.deleteMany({ where: { workspaceId: creditWs } });
  await prisma.workspace.deleteMany({ where: { id: creditWs } });
  await prisma.user.deleteMany({ where: { id: { in: [creditUserA, creditUserB] } } });
  await prisma.$executeRaw`DELETE FROM "AuditLog" WHERE "actorId" = ${actor.id}`;
  await prisma.deployment.deleteMany({ where: { projectId: project.id } });
  await prisma.coolifyServer.deleteMany({ where: { id: server.id } });
  await prisma.$executeRaw`DELETE FROM "GenerationJob" WHERE "projectId" = ${project.id}`;
  await prisma.project.deleteMany({ where: { id: project.id } });
  await prisma.user.deleteMany({
    where: { id: { in: [actor.id, adminA.id, adminB.id, owner.id] } },
  });
} catch (error) {
  failed += 1;
  console.error('FAIL  db assertions', error);
} finally {
  await prisma.$disconnect();
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
