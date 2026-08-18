import '../setup/env';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { testPrismaClient } from '../setup/db';
import { failJob, reconcileAbandonedJobs } from '@/lib/jobs/lifecycle';
import { getJob, insertJobRaw, updateJobFields } from '@/lib/jobs/store';

/**
 * An early `return` from the apply route must settle the job first.
 *
 * The two sandbox pre-flight failures answer with a 409/500 the user reads immediately, but
 * they used to leave the job row RUNNING. The chat's busy state follows that row, so the
 * input stayed locked under a spinning "Building — hang tight" on top of an error the user
 * had already read, until the reaper noticed the stopped heartbeat about a minute later.
 *
 * Behavioural half: the settle the route now makes really does clear the busy state, and
 * skipping it really does leave the wedge. Source half: every early return in the route's
 * job-owning window is preceded by a settle, which the behavioural half cannot show.
 */

const prisma = testPrismaClient();

const USER = 'user_apply_early_return';
const WS = 'ws_apply_early_return';
const PROJECTS = ['proj_apply_settled', 'proj_apply_unsettled'];

const ROUTE = 'app/api/apply-ai-code-stream/route.ts';

/** The copy the route sends when `ensureSandbox` cannot produce a workspace. */
const NO_WORKSPACE =
  'No workspace is running for this project, so the changes could not be applied. Open the project so it can start from its latest snapshot, then try again.';

async function startJob(projectId: string) {
  await prisma.workspace.upsert({
    where: { id: WS },
    create: { id: WS, storageBytes: 0 },
    update: {},
  });
  await prisma.user.upsert({
    where: { id: USER },
    create: {
      id: USER,
      email: 'apply-early-return@example.com',
      name: 'Apply Early Return',
      role: 'MEMBER',
      passwordHash: 'not-a-real-hash',
    },
    update: {},
  });
  await prisma.project.upsert({
    where: { id: projectId },
    create: {
      id: projectId,
      name: 'Apply Early Return',
      ownerId: USER,
      initialPrompt: 'apply early return probe',
    },
    update: {},
  });
  const job = await insertJobRaw({
    projectId,
    workspaceId: WS,
    userId: USER,
    kind: 'FOLLOWUP',
    status: 'RUNNING',
  });
  await updateJobFields(job.id, { startedAt: new Date(), heartbeatAt: new Date() });
  return job;
}

beforeEach(async () => {
  for (const projectId of PROJECTS) {
    await prisma
      .$executeRaw`DELETE FROM "GenerationJob" WHERE "projectId" = ${projectId}`.catch(
      () => undefined,
    );
  }
});

afterAll(async () => {
  for (const projectId of PROJECTS) {
    await prisma
      .$executeRaw`DELETE FROM "GenerationJob" WHERE "projectId" = ${projectId}`.catch(
      () => undefined,
    );
  }
  await prisma.project.deleteMany({ where: { id: { in: PROJECTS } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: USER } }).catch(() => undefined);
  await prisma.$executeRaw`DELETE FROM "Workspace" WHERE id = ${WS}`.catch(() => undefined);
  await prisma.$disconnect();
});

describe('a sandbox pre-flight failure settles the apply job', () => {
  it('leaves a terminal row carrying the reason the user was shown', async () => {
    const job = await startJob('proj_apply_settled');

    await failJob(job.id, { errorCode: 'sandbox_unavailable', errorMessage: NO_WORKSPACE });

    const row = await getJob(job.id);
    // Busy follows QUEUED/RUNNING, so this is the assertion that unlocks the chat.
    expect(row?.status).toBe('FAILED');
    expect(row?.errorCode).toBe('sandbox_unavailable');
    // Same sentence the 409 body carried, so the recovery panel does not contradict the chat.
    expect(row?.errorMessage).toBe(NO_WORKSPACE);
  });

  it('control: returning without the settle waits on the reaper and loses the reason', async () => {
    const job = await startJob('proj_apply_unsettled');

    // Exactly what the two paths used to do: release the lock, answer 409, walk away. The
    // released lock stops the heartbeat, so staleness is the only thing left to settle it.
    // The reaper runs against the whole table, so age this row rather than moving `now` —
    // a `now` in the future would also sweep rows other suites are still using.
    await updateJobFields(job.id, { heartbeatAt: new Date(Date.now() - 30_000) });
    const halfway = await reconcileAbandonedJobs({ projectIds: ['proj_apply_unsettled'] });
    expect(halfway.abandoned.map((entry) => entry.jobId)).not.toContain(job.id);
    // A spinning "Building — hang tight" on top of an error the user has already read.
    expect((await getJob(job.id))?.status).toBe('RUNNING');

    await updateJobFields(job.id, { heartbeatAt: new Date(Date.now() - 10 * 60_000) });
    const later = await reconcileAbandonedJobs({ projectIds: ['proj_apply_unsettled'] });
    expect(later.abandoned.map((entry) => entry.jobId)).toContain(job.id);
    const row = await getJob(job.id);
    // It does end — a minute late, and blaming a restart that never happened.
    expect(row?.status).toBe('ABANDONED');
    expect(row?.errorCode).toBe('server_restarted');
    expect(row?.errorMessage).not.toBe(NO_WORKSPACE);
  });
});

/**
 * Lists early returns in the route's job-owning window that no settle precedes.
 *
 * The window starts where `applyJobId` is assigned (before that there is no row to strand)
 * and ends where the stream takes over (after that the `finally` settles). Scanning it
 * rather than pinning two line numbers keeps a third early return from slipping in later.
 */
function unsettledEarlyReturns(source: string): string[] {
  const start = source.indexOf('applyJobId = applyJob.id;');
  const end = source.indexOf('const stream = new TransformStream();');
  if (start === -1 || end === -1 || end < start) return ['window markers not found'];

  const window = source.slice(start, end);
  const settle = /\b(failApplyJob|failJob|ensureJobSettled)\s*\(/;
  const offenders: string[] = [];
  let cursor = 0;
  for (;;) {
    const at = window.indexOf('return NextResponse.json(', cursor);
    if (at === -1) break;
    if (!settle.test(window.slice(cursor, at))) {
      offenders.push(`line ${source.slice(0, start + at).split('\n').length}`);
    }
    cursor = at + 1;
  }
  return offenders;
}

describe('the apply route never returns while holding a live job', () => {
  const source = readFileSync(resolve(process.cwd(), ROUTE), 'utf8');

  it('settles before every early return once the job row exists', () => {
    expect(unsettledEarlyReturns(source)).toEqual([]);
  });

  it('still has the early returns this guards', () => {
    // The scanner passes trivially on a route that stopped returning early, so pin the two
    // sandbox pre-flight answers down by their status codes.
    expect(source).toContain("boot?.code === 'NO_CHECKPOINT' ? 409 : 500");
    expect(source).toContain(NO_WORKSPACE);
  });
});
