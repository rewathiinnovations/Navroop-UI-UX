import '../setup/env';
import { afterAll, describe, expect, it } from 'vitest';
import { testPrismaClient } from '../setup/db';
import { buildJobUpdate, getJob, insertJobRaw, updateJobFields } from '@/lib/jobs/store';
import { beginJobHeartbeat, reconcileAbandonedJobs } from '@/lib/jobs/lifecycle';
import { HEARTBEAT_FAILURES_BEFORE_STALE, HEARTBEAT_INTERVAL_MS, HEARTBEAT_STALE_MS } from '@/lib/jobs/poll';

/**
 * The job heartbeat, against real Postgres.
 *
 * `beginJobHeartbeat` writes `heartbeatAt` every 10s and `reconcileAbandonedJobs`
 * abandons anything whose `heartbeatAt` is older than 60s. So if the heartbeat write is
 * rejected by the server, every running job is declared stale and killed at the
 * one-minute mark while it is still producing files.
 *
 * That is exactly what happened, and no test caught it: the suites that cover the
 * heartbeat mock Prisma, so they assert that the code *called* the database and never
 * that Postgres *accepted* the statement. These cases execute the real SQL.
 */

const prisma = testPrismaClient();

const USER = 'user_job_heartbeat_sql';
// One project per case: an active job is unique per project, so two RUNNING rows on the
// same project would collide on that index rather than on anything this test is about.
const PROJECT_WRITE = 'proj_job_heartbeat_write';
const PROJECT_TIMER = 'proj_job_heartbeat_timer';
const PROJECT_FRESH_QUEUE = 'proj_job_heartbeat_fresh_queue';
const PROJECT_STALE_QUEUE = 'proj_job_heartbeat_stale_queue';
const PROJECTS = [PROJECT_WRITE, PROJECT_TIMER, PROJECT_FRESH_QUEUE, PROJECT_STALE_QUEUE];
const WS = 'ws_job_heartbeat_sql';

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
      email: 'job-heartbeat-sql@example.com',
      name: 'Heartbeat',
      role: 'MEMBER',
      passwordHash: 'not-a-real-hash',
    },
    update: {},
  });
  await prisma.project.upsert({
    where: { id: projectId },
    create: {
      id: projectId,
      name: 'Heartbeat SQL',
      ownerId: USER,
      initialPrompt: 'heartbeat sql probe',
    },
    update: {},
  });
}

afterAll(async () => {
  for (const projectId of PROJECTS) {
    await prisma.$executeRaw`DELETE FROM "GenerationJob" WHERE "projectId" = ${projectId}`.catch(
      () => undefined,
    );
  }
  await prisma.project.deleteMany({ where: { id: { in: PROJECTS } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: USER } }).catch(() => undefined);
  await prisma.$executeRaw`DELETE FROM "Workspace" WHERE id = ${WS}`.catch(() => undefined);
  await prisma.$disconnect();
});

describe('job heartbeat SQL', () => {
  it('builds a SET clause with one numbered placeholder per value', () => {
    const at = new Date('2026-08-18T00:00:00.000Z');
    const { sql, values } = buildJobUpdate('job_1', { heartbeatAt: at });
    // The regression was a placeholder standing where a column assignment must be.
    expect(sql).toBe('UPDATE "GenerationJob" SET "updatedAt" = NOW(), "heartbeatAt" = $1 WHERE id = $2');
    expect(values).toEqual([at, 'job_1']);
    expect(sql).not.toMatch(/SET\s+\$\d/);
  });

  it('numbers placeholders in order across many fields', () => {
    const { sql, values } = buildJobUpdate('job_2', {
      status: 'RUNNING',
      heartbeatAt: new Date(),
      filesWritten: 3,
      steps: [],
    });
    expect(sql).toContain('status = $1::"JobStatus"');
    expect(sql).toContain('"heartbeatAt" = $2');
    expect(sql).toContain('"filesWritten" = $3');
    expect(sql).toContain('steps = $4::jsonb');
    expect(sql).toContain('WHERE id = $5');
    expect(values).toHaveLength(5);
  });

  it('active-only updates keep the status guard in the same statement', () => {
    const { sql, values } = buildJobUpdate('job_3', { status: 'ABANDONED' }, { activeOnly: true });
    expect(sql).toBe(
      'UPDATE "GenerationJob" SET "updatedAt" = NOW(), status = $1::"JobStatus" WHERE id = $2 AND status IN (\'QUEUED\', \'RUNNING\')',
    );
    expect(values).toEqual(['ABANDONED', 'job_3']);
    expect(sql).not.toMatch(/SET\s+\$\d/);
  });

  it('Postgres accepts the heartbeat write and heartbeatAt advances', async () => {
    await seed(PROJECT_WRITE);
    const job = await insertJobRaw({
      projectId: PROJECT_WRITE,
      workspaceId: WS,
      userId: USER,
      kind: 'BUILD',
      status: 'RUNNING',
    });

    // Old value far enough back that the reaper would abandon this job.
    const stale = new Date(Date.now() - HEARTBEAT_STALE_MS * 2);
    await updateJobFields(job.id, { heartbeatAt: stale });
    const before = await prisma.$queryRaw<Array<{ heartbeatAt: Date | null }>>`
      SELECT "heartbeatAt" FROM "GenerationJob" WHERE id = ${job.id}
    `;
    expect(before[0]?.heartbeatAt?.getTime()).toBe(stale.getTime());

    // The write the timer performs. Before the fix this threw 42601 every tick, so
    // heartbeatAt never moved off `stale`.
    const updated = await updateJobFields(job.id, { heartbeatAt: new Date() });
    expect(updated).not.toBeNull();
    const after = await prisma.$queryRaw<Array<{ heartbeatAt: Date | null }>>`
      SELECT "heartbeatAt" FROM "GenerationJob" WHERE id = ${job.id}
    `;
    const advanced = after[0]?.heartbeatAt?.getTime() ?? 0;
    expect(advanced).toBeGreaterThan(stale.getTime());
    expect(Date.now() - advanced).toBeLessThan(HEARTBEAT_STALE_MS);
  });

  it('the running timer keeps heartbeatAt fresh', async () => {
    await seed(PROJECT_TIMER);
    const job = await insertJobRaw({
      projectId: PROJECT_TIMER,
      workspaceId: WS,
      userId: USER,
      kind: 'EXPORT',
      status: 'RUNNING',
    });
    await updateJobFields(job.id, { heartbeatAt: new Date(Date.now() - HEARTBEAT_STALE_MS * 2) });

    // A short interval so the assertion does not wait 10s; the write is identical.
    const heartbeat = beginJobHeartbeat(job.id, 20);
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      heartbeat.stop();
    }

    const rows = await prisma.$queryRaw<Array<{ heartbeatAt: Date | null }>>`
      SELECT "heartbeatAt" FROM "GenerationJob" WHERE id = ${job.id}
    `;
    const beat = rows[0]?.heartbeatAt?.getTime() ?? 0;
    expect(Date.now() - beat).toBeLessThan(HEARTBEAT_STALE_MS);
  });

  it('the statement shape this replaced is rejected by Postgres', async () => {
    // Not vacuous: this is the SQL the old code produced once the composed SET fragment
    // was bound as a value instead of spliced as text. It is what the running server
    // was sending 74 times, and it must still fail.
    const broken = prisma.$executeRawUnsafe(
      'UPDATE "GenerationJob" SET $1 WHERE id = $2',
      '"heartbeatAt" = NOW()',
      'job_1',
    );
    await expect(broken).rejects.toThrow(/syntax error at or near "\$1"|42601/);
  });

  it('escalation threshold is derived from the heartbeat constants', () => {
    expect(HEARTBEAT_FAILURES_BEFORE_STALE).toBe(HEARTBEAT_STALE_MS / HEARTBEAT_INTERVAL_MS);
    expect(HEARTBEAT_FAILURES_BEFORE_STALE).toBeGreaterThan(1);
  });

  it('does not treat a just-queued job with no heartbeat as a restart leftover', async () => {
    await seed(PROJECT_FRESH_QUEUE);
    const job = await insertJobRaw({
      projectId: PROJECT_FRESH_QUEUE,
      workspaceId: WS,
      userId: USER,
      kind: 'PUBLISH',
      status: 'QUEUED',
      inputPrompt: 'LIVE',
    });
    expect(job.heartbeatAt).toBeNull();

    const result = await reconcileAbandonedJobs({ projectIds: [PROJECT_FRESH_QUEUE] });
    expect(result.abandoned.map((row) => row.jobId)).not.toContain(job.id);
    expect((await getJob(job.id))?.status).toBe('QUEUED');
  });

  it('still abandons a queued job that has had no heartbeat since before the stale window', async () => {
    await seed(PROJECT_STALE_QUEUE);
    const job = await insertJobRaw({
      projectId: PROJECT_STALE_QUEUE,
      workspaceId: WS,
      userId: USER,
      kind: 'PUBLISH',
      status: 'QUEUED',
      inputPrompt: 'LIVE',
    });
    await prisma.$executeRaw`
      UPDATE "GenerationJob"
      SET "createdAt" = NOW() - INTERVAL '90 seconds'
      WHERE id = ${job.id}
    `;

    const result = await reconcileAbandonedJobs({ projectIds: [PROJECT_STALE_QUEUE] });
    expect(result.abandoned.map((row) => row.jobId)).toContain(job.id);
    const after = await getJob(job.id);
    expect(after?.status).toBe('ABANDONED');
    expect(after?.errorCode).toBe('server_restarted');
  });
});
