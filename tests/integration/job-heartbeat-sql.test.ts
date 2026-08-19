import '../setup/env';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { testPrismaClient } from '../setup/db';
import {
  buildJobUpdate,
  getJob,
  insertJobRaw,
  QUEUE_WAITING_JOB_KINDS,
  updateJobFields,
} from '@/lib/jobs/store';
import { beginJobHeartbeat, reconcileAbandonedJobs } from '@/lib/jobs/lifecycle';
import {
  HEARTBEAT_FAILURES_BEFORE_STALE,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALE_MS,
} from '@/lib/jobs/poll';
import { QUEUE_MAX_WAIT_MS } from '@/lib/ai/queue';
import { getInstanceId } from '@/lib/runtime/instance';

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
const PROJECT_QUEUE_WAIT = 'proj_job_heartbeat_queue_wait';
const PROJECT_QUEUE_NO_WAIT = 'proj_job_heartbeat_queue_no_wait';
const PROJECT_OWNER_STAMP = 'proj_job_heartbeat_owner_stamp';
const PROJECTS = [
  PROJECT_WRITE,
  PROJECT_TIMER,
  PROJECT_FRESH_QUEUE,
  PROJECT_STALE_QUEUE,
  PROJECT_QUEUE_WAIT,
  PROJECT_QUEUE_NO_WAIT,
  PROJECT_OWNER_STAMP,
];
const WS = 'ws_job_heartbeat_sql';

/**
 * The queued reaper window is gated on kind in exactly one place — `QUEUE_WAITING_JOB_KINDS`
 * in lib/jobs/store.ts — so these fixtures read their kinds off that list instead of naming
 * a kind that happens to work today. A kind added to or removed from the gate fails these
 * two assertions rather than silently inheriting the wrong window.
 */
const QUEUE_WAITING_KIND = 'BUILD' as const;
const NO_QUEUE_WAIT_KIND = 'PUBLISH' as const;

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
    expect(sql).toBe(
      'UPDATE "GenerationJob" SET "updatedAt" = NOW(), "heartbeatAt" = $1 WHERE id = $2',
    );
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

  it('the fixtures below sit on either side of the one kind gate', () => {
    // The two queued cases only mean what their names say if these hold, and this is the
    // whole of the distinction: one exported list, read by `listReconcileCandidates`.
    expect(QUEUE_WAITING_JOB_KINDS).toContain(QUEUE_WAITING_KIND);
    expect(QUEUE_WAITING_JOB_KINDS).not.toContain(NO_QUEUE_WAIT_KIND);
  });

  it('does not treat a just-queued job with no heartbeat as a restart leftover', async () => {
    await seed(PROJECT_FRESH_QUEUE);
    const job = await insertJobRaw({
      projectId: PROJECT_FRESH_QUEUE,
      workspaceId: WS,
      userId: USER,
      kind: QUEUE_WAITING_KIND,
      status: 'QUEUED',
      inputPrompt: 'build a landing page',
    });
    expect(job.heartbeatAt).toBeNull();

    const result = await reconcileAbandonedJobs({ projectIds: [PROJECT_FRESH_QUEUE] });
    expect(result.abandoned.map((row) => row.jobId)).not.toContain(job.id);
    expect((await getJob(job.id))?.status).toBe('QUEUED');
  });

  it('leaves a queued build alone while it could still be waiting for a provider slot', async () => {
    // This case used to assert the opposite: a queued job with no heartbeat older than the
    // 60-second heartbeat window was abandoned as a restart leftover. But a build parked in
    // the provider queue waits up to QUEUE_MAX_WAIT_MS for a slot and writes no heartbeat
    // until it starts, so that rule killed live builds one minute into a legitimate
    // ten-minute wait — and the route, still holding the QUEUED row, then flipped the
    // ABANDONED row back to RUNNING. A queued row of a queueing kind is judged by the
    // queue's own window now; the restart-leftover case below still holds, one window later.
    //
    // The kind matters: it used to be PUBLISH here, which is precisely a kind that never
    // waits in the provider queue, so the case demonstrated the queue-wait rationale with a
    // job the rationale does not cover.
    await seed(PROJECT_QUEUE_WAIT);
    const job = await insertJobRaw({
      projectId: PROJECT_QUEUE_WAIT,
      workspaceId: WS,
      userId: USER,
      kind: QUEUE_WAITING_KIND,
      status: 'QUEUED',
      inputPrompt: 'build a landing page',
    });
    await prisma.$executeRaw`
      UPDATE "GenerationJob"
      SET "createdAt" = NOW() - INTERVAL '90 seconds'
      WHERE id = ${job.id}
    `;

    const result = await reconcileAbandonedJobs({ projectIds: [PROJECT_QUEUE_WAIT] });
    expect(result.abandoned.map((row) => row.jobId)).not.toContain(job.id);
    expect((await getJob(job.id))?.status).toBe('QUEUED');
  });

  it('still reaps a queued job of a kind that never waits for a slot', async () => {
    // The original restart-leftover contract, kept intact for every kind the queue-wait
    // reasoning does not apply to. A publish calls markJobRunning in the statement after
    // createOrReuseJob, so a PUBLISH row still QUEUED past the heartbeat window means the
    // process that was going to start it is gone — and while it sits there the project
    // stays BUILDING with the chat input locked. Handing the eleven-minute window to every
    // QUEUED row, not just the ones that queue, is how a widened window hides a dead job.
    await seed(PROJECT_QUEUE_NO_WAIT);
    const job = await insertJobRaw({
      projectId: PROJECT_QUEUE_NO_WAIT,
      workspaceId: WS,
      userId: USER,
      kind: NO_QUEUE_WAIT_KIND,
      status: 'QUEUED',
      inputPrompt: 'LIVE',
    });
    await prisma.$executeRaw`
      UPDATE "GenerationJob"
      SET "createdAt" = NOW() - INTERVAL '90 seconds'
      WHERE id = ${job.id}
    `;

    const result = await reconcileAbandonedJobs({ projectIds: [PROJECT_QUEUE_NO_WAIT] });
    expect(result.abandoned.map((row) => row.jobId)).toContain(job.id);
    const after = await getJob(job.id);
    expect(after?.status).toBe('ABANDONED');
    expect(after?.errorCode).toBe('server_restarted');
  });

  it('abandons a queued job left behind for longer than the whole queue wait', async () => {
    await seed(PROJECT_STALE_QUEUE);
    const job = await insertJobRaw({
      projectId: PROJECT_STALE_QUEUE,
      workspaceId: WS,
      userId: USER,
      kind: QUEUE_WAITING_KIND,
      status: 'QUEUED',
      inputPrompt: 'build a landing page',
    });
    // Past the queued window (queue wait + heartbeat window), so no live queue wait can
    // explain this row: whatever was going to start it is gone.
    const agedSeconds = Math.ceil((QUEUE_MAX_WAIT_MS + HEARTBEAT_STALE_MS) / 1000) + 30;
    await prisma.$executeRaw`
      UPDATE "GenerationJob"
      SET "createdAt" = NOW() - (${agedSeconds}::int * INTERVAL '1 second')
      WHERE id = ${job.id}
    `;

    const result = await reconcileAbandonedJobs({ projectIds: [PROJECT_STALE_QUEUE] });
    expect(result.abandoned.map((row) => row.jobId)).toContain(job.id);
    const after = await getJob(job.id);
    expect(after?.status).toBe('ABANDONED');
    expect(after?.errorCode).toBe('server_restarted');
  });

  it('stamps an owner a separately evaluated copy of the module still matches', async () => {
    // The eleven-minute queued window is only tolerable because the SIGTERM drain settles
    // queued rows immediately, and that drain is `WHERE "ownerInstance" = getInstanceId()`
    // against the id stamped here at insert. It is wired from instrumentation.ts, which Next
    // bundles separately from route handlers, so the two reads can come from two evaluations
    // of lib/runtime/instance. A module-level constant minted a second id there, the fence
    // matched nothing, and the drain settled zero rows — indistinguishable from having
    // nothing to settle, leaving the queued window as the only recovery.
    await seed(PROJECT_OWNER_STAMP);
    const job = await insertJobRaw({
      projectId: PROJECT_OWNER_STAMP,
      workspaceId: WS,
      userId: USER,
      kind: QUEUE_WAITING_KIND,
      status: 'QUEUED',
      inputPrompt: 'build a landing page',
    });
    const rows = await prisma.$queryRaw<Array<{ ownerInstance: string | null }>>`
      SELECT "ownerInstance" FROM "GenerationJob" WHERE id = ${job.id}
    `;
    expect(rows[0]?.ownerInstance).toBe(getInstanceId());

    // Deliberately a dynamic import after resetModules: the whole point is to evaluate the
    // module a second time, which the static import at the top of this file cannot do — it
    // is the very instance whose memo we are checking is shared.
    vi.resetModules();
    const reloaded = await import('@/lib/runtime/instance');
    expect(reloaded.getInstanceId()).toBe(rows[0]?.ownerInstance);
  });
});
