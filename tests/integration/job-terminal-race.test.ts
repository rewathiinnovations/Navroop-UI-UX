import '../setup/env';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { testPrismaClient } from '../setup/db';
import {
  abandonJob,
  failJob,
  reconcileAbandonedJobs,
  succeedJob,
} from '@/lib/jobs/lifecycle';
import { ensureJobSettled } from '@/lib/jobs/settle';
import { getJob, insertJobRaw, listReconcileCandidates, updateJobFields } from '@/lib/jobs/store';
import { HEARTBEAT_STALE_MS } from '@/lib/jobs/poll';

/**
 * A job already in the reaper's candidate list can succeed before the abandon
 * write lands. The status UPDATE must be a no-op when the row is no longer
 * QUEUED/RUNNING — otherwise a finished build is reported as abandoned.
 */

const prisma = testPrismaClient();

const USER = 'user_job_terminal_race';
const WS = 'ws_job_terminal_race';
const PROJECTS = [
  'proj_race_abandon',
  'proj_race_fail',
  'proj_race_succeed',
  'proj_race_settle',
  'proj_race_settle_abandon',
  'proj_race_reaper',
  'proj_race_reaper_abandon',
  'proj_race_publish',
] as const;

async function seed(projectId: string) {
  await prisma.workspace.upsert({
    where: { id: WS },
    create: { id: WS, storageBytes: 0 },
    update: {},
  });
  await prisma.user.upsert({
    where: { id: USER },
    create: {
      id: USER,
      email: 'job-terminal-race@example.com',
      name: 'Race',
      role: 'MEMBER',
      passwordHash: 'not-a-real-hash',
    },
    update: {},
  });
  await prisma.project.upsert({
    where: { id: projectId },
    create: { id: projectId, name: 'Race', ownerId: USER, initialPrompt: 'race probe' },
    update: {},
  });
}

async function startRunningJob(
  projectId: string,
  kind: 'FOLLOWUP' | 'PUBLISH' = 'FOLLOWUP',
  heartbeatAt: Date = new Date(),
) {
  await seed(projectId);
  const job = await insertJobRaw({
    projectId,
    workspaceId: WS,
    userId: USER,
    kind,
    status: 'RUNNING',
    inputPrompt: kind === 'PUBLISH' ? 'LIVE' : 'race probe',
  });
  await updateJobFields(job.id, {
    startedAt: heartbeatAt,
    heartbeatAt,
    lastStep: 'apply',
    resourceIds: kind === 'PUBLISH' ? { coolifyAppUuid: 'coolify-app-race' } : null,
  });
  return job;
}

function startStaleRunningJob(projectId: string, kind: 'FOLLOWUP' | 'PUBLISH' = 'FOLLOWUP') {
  return startRunningJob(projectId, kind, new Date(Date.now() - HEARTBEAT_STALE_MS * 2));
}

function staleBefore() {
  return new Date(Date.now() - HEARTBEAT_STALE_MS);
}

beforeEach(async () => {
  for (const projectId of PROJECTS) {
    await prisma.$executeRaw`DELETE FROM "GenerationJob" WHERE "projectId" = ${projectId}`.catch(
      () => undefined,
    );
  }
});

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

describe('terminal job writes are atomic', () => {
  it('a reaper-candidate job that succeeds before the abandon write stays SUCCEEDED', async () => {
    const job = await startStaleRunningJob('proj_race_abandon');
    const candidates = await listReconcileCandidates(staleBefore());
    expect(candidates.map((row) => row.id)).toContain(job.id);

    const abandoned = await abandonJob(
      job.id,
      { errorCode: 'server_restarted', errorMessage: 'The server restarted' },
      { beforeWrite: () => succeedJob(job.id, { lastStep: 'live' }) },
    );

    expect(abandoned?.status).toBe('SUCCEEDED');
    expect((await getJob(job.id))?.status).toBe('SUCCEEDED');
    expect((await getJob(job.id))?.errorCode).not.toBe('server_restarted');
    expect((await getJob(job.id))?.lastStep).toBe('live');
  });

  it('failJob does not overwrite SUCCEEDED when the write loses the race', async () => {
    const job = await startRunningJob('proj_race_fail');

    const failed = await failJob(
      job.id,
      { errorCode: 'provider_error', errorMessage: 'late fail' },
      { beforeWrite: () => succeedJob(job.id) },
    );

    expect(failed?.status).toBe('SUCCEEDED');
    expect((await getJob(job.id))?.status).toBe('SUCCEEDED');
    expect((await getJob(job.id))?.errorCode).not.toBe('provider_error');
  });

  it('succeedJob does not overwrite FAILED when the write loses the race', async () => {
    const job = await startRunningJob('proj_race_succeed');

    const succeeded = await succeedJob(job.id, { lastStep: 'live' }, {
      beforeWrite: () => failJob(job.id, { errorCode: 'provider_error', errorMessage: 'won' }),
    });

    expect(succeeded?.status).toBe('FAILED');
    expect((await getJob(job.id))?.status).toBe('FAILED');
    expect((await getJob(job.id))?.errorCode).toBe('provider_error');
  });

  it('ensureJobSettled is already_settled when abandon loses to succeed', async () => {
    const job = await startRunningJob('proj_race_settle');

    expect(
      await ensureJobSettled(
        job.id,
        { errorCode: 'server_restarted' },
        { beforeWrite: () => succeedJob(job.id) },
      ),
    ).toBe('already_settled');
    expect((await getJob(job.id))?.status).toBe('SUCCEEDED');
    expect((await getJob(job.id))?.errorCode).not.toBe('server_restarted');
  });

  it('ensureJobSettled is already_settled when abandon loses to another abandon', async () => {
    const job = await startRunningJob('proj_race_settle_abandon');

    expect(
      await ensureJobSettled(
        job.id,
        { errorCode: 'client_disconnected' },
        { beforeWrite: () => abandonJob(job.id, { errorCode: 'server_restarted' }) },
      ),
    ).toBe('already_settled');
    const after = await getJob(job.id);
    expect(after?.status).toBe('ABANDONED');
    expect(after?.errorCode).toBe('server_restarted');
    expect(after?.errorCode).not.toBe('client_disconnected');
  });

  it('the reaper does not report a candidate that succeeded before abandon wrote', async () => {
    const job = await startStaleRunningJob('proj_race_reaper');
    const candidates = await listReconcileCandidates(staleBefore());
    expect(candidates.map((row) => row.id)).toContain(job.id);

    const result = await reconcileAbandonedJobs({
      beforeAbandon: () => succeedJob(job.id),
      projectIds: ['proj_race_reaper'],
    });
    expect(result.abandoned.map((row) => row.jobId)).not.toContain(job.id);
    expect((await getJob(job.id))?.status).toBe('SUCCEEDED');
  });

  it('the reaper does not report a candidate another abandon already settled', async () => {
    const job = await startStaleRunningJob('proj_race_reaper_abandon');
    const candidates = await listReconcileCandidates(staleBefore());
    expect(candidates.map((row) => row.id)).toContain(job.id);

    const result = await reconcileAbandonedJobs({
      beforeAbandon: () => abandonJob(job.id, { errorCode: 'admin_abandoned' }),
      projectIds: ['proj_race_reaper_abandon'],
    });
    expect(result.abandoned.map((row) => row.jobId)).not.toContain(job.id);
    expect((await getJob(job.id))?.status).toBe('ABANDONED');
    expect((await getJob(job.id))?.errorCode).toBe('admin_abandoned');
  });

  it('a lost publish abandon does not compensate a successful deployment', async () => {
    const job = await startRunningJob('proj_race_publish', 'PUBLISH');

    const abandoned = await abandonJob(
      job.id,
      { errorCode: 'server_restarted', errorMessage: 'The server restarted' },
      { beforeWrite: () => succeedJob(job.id, { lastStep: 'live' }) },
    );

    const after = await getJob(job.id);
    expect(abandoned?.status).toBe('SUCCEEDED');
    expect(after?.status).toBe('SUCCEEDED');
    expect(after?.lastStep).toBe('live');
    expect(after?.resourceIds.compensation ?? null).toBeNull();
    expect(after?.errorCode).not.toBe('server_restarted');
  });
});
