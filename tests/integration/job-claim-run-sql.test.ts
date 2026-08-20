import '../setup/env';
import { afterAll, describe, expect, it } from 'vitest';
import { testPrismaClient } from '../setup/db';
import { claimJobRun, getJob, insertJobRaw, updateJobFields } from '@/lib/jobs/store';
import type { JobStatus } from '@/generated/prisma';

/**
 * The exclusive run claim, on real Postgres.
 *
 * The whole fix is a WHERE clause, and the suites that drive the publish loop stub the
 * store — so the predicate that *is* the fix would be unverified by them. Every branch is
 * load-bearing and each one fails differently:
 *
 * - QUEUED must win, or no publish ever starts.
 * - A RUNNING row with a live heartbeat must lose, or two runners walk one publish again
 *   (F-203): two force-pushes on one branch, two `triggerDeploy` calls, and possibly two
 *   Coolify applications for one deployment.
 * - A RUNNING row whose heartbeat stopped must be takeable, or a crashed instance's work
 *   can never be resumed by anyone.
 * - A settled row must lose, or a finished job is resurrected as RUNNING.
 */

const prisma = testPrismaClient();

const USER = 'user_job_claim_run';
const WS = 'ws_job_claim_run';

/** One project per row: `one_active_job_per_project` is unique. */
const PROJECTS = [
  'proj_claim_queued',
  'proj_claim_running_fresh',
  'proj_claim_running_stale',
  'proj_claim_running_never',
  'proj_claim_succeeded',
  'proj_claim_takeover_started',
] as const;

const FRESH = new Date(Date.now() - 60_000);

async function seedJob(projectId: (typeof PROJECTS)[number], status: JobStatus) {
  await prisma.workspace.upsert({
    where: { id: WS },
    create: { id: WS, storageBytes: 0 },
    update: {},
  });
  await prisma.user.upsert({
    where: { id: USER },
    create: {
      id: USER,
      email: 'job-claim-run@example.com',
      name: 'Claim Run',
      role: 'MEMBER',
      passwordHash: 'not-a-real-hash',
    },
    update: {},
  });
  await prisma.project.upsert({
    where: { id: projectId },
    create: {
      id: projectId,
      name: 'Claim run SQL',
      ownerId: USER,
      initialPrompt: 'claim run probe',
    },
    update: {},
  });
  return insertJobRaw({ projectId, workspaceId: WS, userId: USER, kind: 'PUBLISH', status });
}

afterAll(async () => {
  for (const projectId of PROJECTS) {
    await prisma.$executeRaw`DELETE FROM "GenerationJob" WHERE "projectId" = ${projectId}`.catch(
      () => undefined,
    );
  }
  await prisma.project.deleteMany({ where: { id: { in: [...PROJECTS] } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: USER } }).catch(() => undefined);
  await prisma.$executeRaw`DELETE FROM "Workspace" WHERE id = ${WS}`.catch(() => undefined);
  await prisma.$disconnect();
});

describe('claimJobRun', () => {
  it('takes a QUEUED job and stamps this runner on it', async () => {
    const job = await seedJob('proj_claim_queued', 'QUEUED');

    expect(await claimJobRun(job.id, 'instance-a', FRESH)).toBe(true);

    const claimed = await getJob(job.id);
    expect(claimed?.status).toBe('RUNNING');
    expect(claimed?.ownerInstance).toBe('instance-a');
    expect(claimed?.startedAt).toBeInstanceOf(Date);
    expect(claimed?.heartbeatAt).toBeInstanceOf(Date);
  });

  it('refuses a job whose runner is still heartbeating', async () => {
    const job = await seedJob('proj_claim_running_fresh', 'QUEUED');
    expect(await claimJobRun(job.id, 'instance-a', FRESH)).toBe(true);

    // The second click, the second tab, the second POST.
    expect(await claimJobRun(job.id, 'instance-b', FRESH)).toBe(false);

    const held = await getJob(job.id);
    expect(held?.ownerInstance).toBe('instance-a');
  });

  it('lets a new runner take over a job whose heartbeat stopped', async () => {
    // A stale heartbeat *is* the ownership test — the same one `reconcileAbandonedJobs`
    // uses. Fencing on ownerInstance instead would strand every job of a crashed
    // instance, because that instance is never coming back to release them.
    const job = await seedJob('proj_claim_running_stale', 'RUNNING');
    await updateJobFields(job.id, {
      ownerInstance: 'instance-gone',
      heartbeatAt: new Date(Date.now() - 5 * 60_000),
    });

    expect(await claimJobRun(job.id, 'instance-b', FRESH)).toBe(true);
    expect((await getJob(job.id))?.ownerInstance).toBe('instance-b');
  });

  it('treats a RUNNING row that never heartbeat as unowned', async () => {
    const job = await seedJob('proj_claim_running_never', 'RUNNING');
    await updateJobFields(job.id, { ownerInstance: 'instance-gone', heartbeatAt: null });

    expect(await claimJobRun(job.id, 'instance-b', FRESH)).toBe(true);
  });

  it('never resurrects a settled job', async () => {
    const job = await seedJob('proj_claim_succeeded', 'SUCCEEDED');

    expect(await claimJobRun(job.id, 'instance-a', FRESH)).toBe(false);
    expect((await getJob(job.id))?.status).toBe('SUCCEEDED');
  });

  it('keeps the original startedAt when a stale job is taken over', async () => {
    const started = new Date('2026-08-01T00:00:00.000Z');
    const job = await seedJob('proj_claim_takeover_started', 'RUNNING');
    await updateJobFields(job.id, {
      ownerInstance: 'instance-gone',
      startedAt: started,
      heartbeatAt: new Date(Date.now() - 5 * 60_000),
    });

    expect(await claimJobRun(job.id, 'instance-c', FRESH)).toBe(true);
    // `/admin/jobs` reads startedAt to show how long a build has been going; a takeover
    // is the same run continuing, not a new one.
    expect((await getJob(job.id))?.startedAt).toEqual(started);
  });
});
