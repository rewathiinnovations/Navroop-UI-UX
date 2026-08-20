/**
 * Durable GenerationJob: abandon, timeout, one-active, idempotency, credits, lock, poll.
 * Registered in `tests/setup/suites.ts` (DB_SUITES) and run by
 * `tests/integration/legacy-db-suites.test.ts`. Unscoped `reconcileAbandonedJobs`
 * would steal other suites' GenerationJob rows — every call here passes `projectIds`.
 */
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { testPrismaClient } from './setup/db.ts';
import { hashPassword } from '../lib/password.ts';
import { acquireLock } from '../lib/projects/lock.ts';
import { consumeCredits } from '../lib/plans/limits.ts';
import {
  CLIENT_POLL_CEILING_MS,
  CLIENT_STALE_HEARTBEAT_MS,
  HEARTBEAT_STALE_MS,
  JOB_TIMEOUT_MS,
  nextPollIntervalMs,
  shouldStopClientPoll,
} from '../lib/jobs/poll.ts';
import { getInstanceId } from '../lib/runtime/instance.ts';
import {
  abandonJob,
  chargeJobCreditsOnce,
  createOrReuseJob,
  markJobRunning,
  reconcileAbandonedJobs,
} from '../lib/jobs/lifecycle.ts';
import { getJob, insertJobRaw } from '../lib/jobs/store.ts';
import { revertApprovedPlan } from '../lib/projects/plan-compensate.ts';
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

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
const ownerEmail = `job-owner-${suffix}@example.com`;

// Scope every workspace write to a row this suite owns, so the credit-delta assertions
// below never touch the singleton `default` workspace that publish-execute,
// publish-compensate-resume and sentry-runtime-file (all in parallel worker files) read
// and write. Before this, those suites raced this one's creditsUsed writes (F-606).
const WORKSPACE_ROW_ID = `ws_generation_jobs`;

const now = new Date('2026-08-17T12:00:00.000Z');
assert(
  shouldStopClientPoll({
    startedAtMs: now.getTime() - CLIENT_POLL_CEILING_MS - 1,
    heartbeatAt: now,
    now,
  }) === 'timeout',
  'client poll ceiling at 25 minutes → recovery timeout',
);
assert(
  shouldStopClientPoll({
    startedAtMs: now.getTime(),
    heartbeatAt: new Date(now.getTime() - CLIENT_STALE_HEARTBEAT_MS - 1),
    now,
  }) === 'stale_heartbeat',
  'client poll stops when heartbeat is stale by more than 90s',
);
assert(
  shouldStopClientPoll({
    startedAtMs: now.getTime(),
    heartbeatAt: new Date(now.getTime() - 30_000),
    now,
  }) === null,
  'client keeps polling when heartbeat is fresh',
);
assert(nextPollIntervalMs(30_000) === 2_000, 'poll interval is 2s in the first two minutes');
assert(nextPollIntervalMs(120_001) === 10_000, 'poll interval backs off to 10s after two minutes');

const instanceA = getInstanceId();
const instanceB = getInstanceId();
assert(typeof instanceA === 'string' && instanceA.length > 8, 'instance id is a non-empty string');
assert(instanceA === instanceB, 'instance id is stable for the process lifetime');

try {
  await ensureDefaultPlan(prisma);
  await prisma.workspace.upsert({
    where: { id: WORKSPACE_ROW_ID },
    create: { id: WORKSPACE_ROW_ID, storageBytes: 0, creditsUsed: 0 },
    update: { creditsUsed: 0, creditAlert80Sent: false },
  });
  const passwordHash = await hashPassword('JobTest123');
  const owner = await prisma.user.create({
    data: { email: ownerEmail, name: 'Job Owner', passwordHash, role: 'MEMBER' },
  });

  const project = await prisma.project.create({
    data: {
      name: `Job test ${suffix}`,
      initialPrompt: 'build a landing page',
      ownerId: owner.id,
      phase: 'BUILDING',
      generationStatus: 'idle',
    },
  });

  const stale = await createOrReuseJob({
    projectId: project.id,
    workspaceId: WORKSPACE_ROW_ID,
    userId: owner.id,
    kind: 'BUILD',
    inputPrompt: 'build a landing page',
  });
  await markJobRunning(stale.id, {
    ownerInstance: 'other-instance',
    chargeCredits: false,
  });
  await prisma.$executeRaw`
    UPDATE "GenerationJob"
    SET "heartbeatAt" = NOW() - INTERVAL '90 seconds'
    WHERE id = ${stale.id}
  `;
  const acquired = await acquireLock(project.id, owner.id, 'generation');
  assert(acquired.ok === true, 'lock acquired for stale-heartbeat job');

  const staleResult = await reconcileAbandonedJobs({
    now: new Date(),
    timeoutMs: JOB_TIMEOUT_MS,
    staleMs: HEARTBEAT_STALE_MS,
    projectIds: [project.id],
  });
  const afterStale = await getJob(stale.id);
  const lockAfterStale = await prisma.$queryRaw<
    Array<{ lockedById: string | null; phase: string; activeJobId: string | null }>
  >`
    SELECT "lockedById", phase::text AS phase, "activeJobId"
    FROM "Project"
    WHERE id = ${project.id}
  `;
  assert(afterStale?.status === 'ABANDONED', 'stale heartbeat is abandoned');
  assert(
    afterStale?.errorCode === 'server_restarted',
    'stale heartbeat errorCode is server_restarted',
  );
  assert(lockAfterStale[0]?.lockedById == null, 'lock released on ABANDONED');
  assert(lockAfterStale[0]?.activeJobId == null, 'activeJobId cleared on abandon');
  assert(lockAfterStale[0]?.phase !== 'BUILDING', 'phase is resumable after abandon');
  assert(
    staleResult.abandoned.some((row) => row.jobId === stale.id),
    'reconcile reports the stale job',
  );

  const timed = await createOrReuseJob({
    projectId: project.id,
    workspaceId: WORKSPACE_ROW_ID,
    userId: owner.id,
    kind: 'BUILD',
    inputPrompt: 'timeout case',
  });
  await markJobRunning(timed.id, {
    ownerInstance: getInstanceId(),
    chargeCredits: false,
  });
  await prisma.$executeRaw`
    UPDATE "GenerationJob"
    SET
      "startedAt" = NOW() - INTERVAL '21 minutes',
      "heartbeatAt" = NOW()
    WHERE id = ${timed.id}
  `;
  await reconcileAbandonedJobs({
    now: new Date(),
    timeoutMs: JOB_TIMEOUT_MS,
    staleMs: HEARTBEAT_STALE_MS,
    projectIds: [project.id],
  });
  const afterTimeout = await getJob(timed.id);
  assert(afterTimeout?.status === 'ABANDONED', 'RUNNING job older than 20 min is abandoned');
  assert(afterTimeout?.errorCode === 'timeout', 'timeout errorCode even with fresh heartbeat');

  // Short/auxiliary kinds (withRecordedJob) are reaped on staleness like any other
  // kind — which is why they now keep a heartbeat while they are actually working.
  const shortJob = await insertJobRaw({
    projectId: project.id,
    workspaceId: WORKSPACE_ROW_ID,
    userId: owner.id,
    kind: 'EXPORT',
    inputPrompt: 'export the project',
  });
  await markJobRunning(shortJob.id, {
    ownerInstance: 'other-instance',
    chargeCredits: false,
    acquireProjectLock: false,
  });
  const freshShort = await reconcileAbandonedJobs({
    now: new Date(),
    timeoutMs: JOB_TIMEOUT_MS,
    staleMs: HEARTBEAT_STALE_MS,
    projectIds: [project.id],
  });
  assert(
    freshShort.abandoned.every((row) => row.jobId !== shortJob.id),
    'a short job with a fresh heartbeat is left alone',
  );
  await prisma.$executeRaw`
    UPDATE "GenerationJob"
    SET "heartbeatAt" = NOW() - INTERVAL '90 seconds'
    WHERE id = ${shortJob.id}
  `;
  const staleShort = await reconcileAbandonedJobs({
    now: new Date(),
    timeoutMs: JOB_TIMEOUT_MS,
    staleMs: HEARTBEAT_STALE_MS,
    projectIds: [project.id],
  });
  const afterShort = await getJob(shortJob.id);
  assert(afterShort?.status === 'ABANDONED', 'stale EXPORT job is reaped on staleness');
  assert(
    staleShort.abandoned.some((row) => row.jobId === shortJob.id),
    'reconcile reports the stale short job',
  );

  // approvePlan marks the plan APPROVED + the project BUILDING in one transaction and
  // then creates the job. If job creation throws there is nothing to move the project
  // out of BUILDING, so the compensation has to put both rows back.
  const plan = await prisma.projectPlan.create({
    data: {
      projectId: project.id,
      version: 1,
      content: { summary: 'compensation test', steps: [] },
      status: 'APPROVED',
      sourceMessage: 'build a landing page',
      trigger: 'initial',
    },
  });
  await prisma.project.update({ where: { id: project.id }, data: { phase: 'BUILDING' } });
  const reverted = await revertApprovedPlan({ projectId: project.id, planId: plan.id });
  const planAfterRevert = await prisma.projectPlan.findUnique({
    where: { id: plan.id },
    select: { status: true },
  });
  const projectAfterRevert = await prisma.project.findUnique({
    where: { id: project.id },
    select: { phase: true },
  });
  assert(reverted.planReverted && reverted.phaseReverted, 'compensation reports both reverts');
  assert(planAfterRevert?.status === 'PENDING', 'failed job creation leaves the plan PENDING');
  assert(
    projectAfterRevert?.phase !== 'BUILDING',
    'failed job creation does not leave phase BUILDING',
  );
  assert(
    projectAfterRevert?.phase === 'PLANNING',
    'phase goes back to PLANNING so approve works again',
  );

  const revertedTwice = await revertApprovedPlan({ projectId: project.id, planId: plan.id });
  assert(
    revertedTwice.planReverted === false && revertedTwice.phaseReverted === false,
    'compensation is idempotent — a second run changes nothing',
  );

  await prisma.project.update({ where: { id: project.id }, data: { phase: 'COMPLETE' } });
  await revertApprovedPlan({ projectId: project.id, planId: plan.id });
  const movedOn = await prisma.project.findUnique({
    where: { id: project.id },
    select: { phase: true },
  });
  assert(movedOn?.phase === 'COMPLETE', 'compensation never clobbers a project that moved on');
  await prisma.projectPlan.delete({ where: { id: plan.id } });
  await prisma.project.update({ where: { id: project.id }, data: { phase: 'PLANNING' } });

  const firstActive = await createOrReuseJob({
    projectId: project.id,
    workspaceId: WORKSPACE_ROW_ID,
    userId: owner.id,
    kind: 'BUILD',
    inputPrompt: 'one active',
  });
  let secondBlocked = false;
  try {
    await insertJobRaw({
      projectId: project.id,
      workspaceId: WORKSPACE_ROW_ID,
      userId: owner.id,
      kind: 'BUILD',
      status: 'QUEUED',
      inputPrompt: 'second',
    });
  } catch {
    secondBlocked = true;
  }
  assert(secondBlocked, 'one active job per project (partial unique index)');
  await abandonJob(firstActive.id, {
    errorCode: 'server_restarted',
    errorMessage: 'cleanup one-active fixture',
  });

  const key = `idem-${suffix}`;
  const a = await createOrReuseJob({
    projectId: project.id,
    workspaceId: WORKSPACE_ROW_ID,
    userId: owner.id,
    kind: 'BUILD',
    inputPrompt: 'approve twice',
    idempotencyKey: key,
  });
  await markJobRunning(a.id, { ownerInstance: getInstanceId(), chargeCredits: false });
  const b = await createOrReuseJob({
    projectId: project.id,
    workspaceId: WORKSPACE_ROW_ID,
    userId: owner.id,
    kind: 'BUILD',
    inputPrompt: 'approve twice',
    idempotencyKey: key,
  });
  assert(a.id === b.id, 'idempotency key reuse returns the same RUNNING job');
  const succeededTwin = await createOrReuseJob({
    projectId: project.id,
    workspaceId: WORKSPACE_ROW_ID,
    userId: owner.id,
    kind: 'BUILD',
    inputPrompt: 'approve twice',
    idempotencyKey: key,
  });
  assert(
    succeededTwin.id === a.id,
    'idempotency key reuse while RUNNING does not start a second job',
  );
  await abandonJob(a.id, { errorCode: 'server_restarted', errorMessage: 'cleanup idempotency' });

  // Reset the counter, not just create it. The cases below each consume a credit and the
  // row is shared across runs, so `update: {}` let usage creep up until the suite failed
  // with "This month's credits are used up" after roughly a hundred runs. The assertions
  // are all deltas, so starting from zero does not weaken them.
  await prisma.workspace.upsert({
    where: { id: WORKSPACE_ROW_ID },
    create: { id: WORKSPACE_ROW_ID, storageBytes: 0, creditsUsed: 0 },
    update: { creditsUsed: 0, creditAlert80Sent: false },
  });
  const beforeCredits = await prisma.workspace.findUniqueOrThrow({
    where: { id: WORKSPACE_ROW_ID },
    select: { creditsUsed: true },
  });
  const billed = await createOrReuseJob({
    projectId: project.id,
    workspaceId: WORKSPACE_ROW_ID,
    userId: owner.id,
    kind: 'BUILD',
    inputPrompt: 'credits once',
  });
  await markJobRunning(billed.id, { ownerInstance: getInstanceId(), chargeCredits: true });
  await chargeJobCreditsOnce(billed.id, {
    workspaceId: WORKSPACE_ROW_ID,
    userId: owner.id,
    action: 'generation',
    projectId: project.id,
  });
  await chargeJobCreditsOnce(billed.id, {
    workspaceId: WORKSPACE_ROW_ID,
    userId: owner.id,
    action: 'generation',
    projectId: project.id,
  });
  const afterCredits = await prisma.workspace.findUniqueOrThrow({
    where: { id: WORKSPACE_ROW_ID },
    select: { creditsUsed: true },
  });
  assert(
    afterCredits.creditsUsed === beforeCredits.creditsUsed + 1,
    'credits charged once per job at RUNNING, not per retry',
  );
  await abandonJob(billed.id, { errorCode: 'server_restarted', errorMessage: 'cleanup credits' });

  // Two replicas can call chargeJobCreditsOnce for the same job at the same time.
  const racedJob = await createOrReuseJob({
    projectId: project.id,
    workspaceId: WORKSPACE_ROW_ID,
    userId: owner.id,
    kind: 'BUILD',
    inputPrompt: 'credits once concurrently',
  });
  const beforeRaced = await prisma.workspace.findUniqueOrThrow({
    where: { id: WORKSPACE_ROW_ID },
    select: { creditsUsed: true },
  });
  const racedCharge = {
    workspaceId: WORKSPACE_ROW_ID,
    userId: owner.id,
    action: 'generation' as const,
    projectId: project.id,
  };
  const racedResults = await Promise.all([
    chargeJobCreditsOnce(racedJob.id, racedCharge),
    chargeJobCreditsOnce(racedJob.id, racedCharge),
  ]);
  const afterRaced = await prisma.workspace.findUniqueOrThrow({
    where: { id: WORKSPACE_ROW_ID },
    select: { creditsUsed: true },
  });
  assert(
    racedResults.filter((row) => row.charged).length === 1,
    'concurrent chargeJobCreditsOnce: exactly one caller charges',
  );
  assert(
    afterRaced.creditsUsed === beforeRaced.creditsUsed + 1,
    'concurrent chargeJobCreditsOnce debits the workspace once',
  );
  await abandonJob(racedJob.id, {
    errorCode: 'server_restarted',
    errorMessage: 'cleanup raced credits',
  });

  const legacy = await prisma.project.create({
    data: {
      name: `Legacy stuck ${suffix}`,
      initialPrompt: 'stuck building',
      ownerId: owner.id,
      phase: 'BUILDING',
      generationStatus: 'idle',
    },
  });
  await reconcileAbandonedJobs({
    now: new Date(),
    timeoutMs: JOB_TIMEOUT_MS,
    staleMs: HEARTBEAT_STALE_MS,
    projectIds: [legacy.id],
  });
  const legacyAfter = await prisma.project.findUnique({
    where: { id: legacy.id },
    select: { phase: true, generationStatus: true },
  });
  assert(
    legacyAfter?.phase !== 'BUILDING',
    'legacy BUILDING + idle + no job row is unstuck at reconcile',
  );
  assert(legacyAfter?.generationStatus === 'idle', 'legacy unstuck project stays idle');

  await consumeCredits(WORKSPACE_ROW_ID, owner.id, 'generation', project.id).catch(() => undefined);
  await prisma.project.deleteMany({ where: { id: { in: [project.id, legacy.id] } } });
  await prisma.user.delete({ where: { id: owner.id } });
} catch (error) {
  failed += 1;
  console.error('FAIL  generation-jobs suite', error);
} finally {
  await prisma.$disconnect();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
