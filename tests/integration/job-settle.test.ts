import '../setup/env';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { testPrismaClient } from '../setup/db';
import { beginJobHeartbeat, failJob, succeedJob } from '@/lib/jobs/lifecycle';
import { ensureJobSettled } from '@/lib/jobs/settle';
import { insertJobRaw, updateJobFields } from '@/lib/jobs/store';
import { HEARTBEAT_STALE_MS } from '@/lib/jobs/poll';

/**
 * A job must always reach a terminal status, and its heartbeat must never outlive it.
 *
 * The failure this pins down: a generation route settles on the happy path and in its
 * `catch`, but a client that disconnects mid-stream parks the handler on a write nobody
 * reads. Neither branch runs, `finally` never runs either, so the heartbeat keeps
 * `heartbeatAt` fresh — and a fresh heartbeat is exactly what makes the staleness reaper
 * skip the row. The job then sits RUNNING until the 20-minute hard timeout with the
 * workspace chat input locked.
 */

const prisma = testPrismaClient();

const USER = 'user_job_settle';
const WS = 'ws_job_settle';
const PROJECTS = [
  'proj_settle_throw',
  'proj_settle_cancel',
  'proj_settle_idem',
  'proj_settle_abort',
];

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
      email: 'job-settle@example.com',
      name: 'Settle',
      role: 'MEMBER',
      passwordHash: 'not-a-real-hash',
    },
    update: {},
  });
  await prisma.project.upsert({
    where: { id: projectId },
    create: { id: projectId, name: 'Settle', ownerId: USER, initialPrompt: 'settle probe' },
    update: {},
  });
}

async function startJob(projectId: string) {
  await seed(projectId);
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

function statusOf(jobId: string) {
  return prisma.$queryRaw<Array<{ status: string; heartbeatAt: Date | null }>>`
    SELECT status, "heartbeatAt" FROM "GenerationJob" WHERE id = ${jobId}
  `;
}

const INTERVAL_MS = 20;
/**
 * Generous on purpose. "The heartbeat advanced" is the claim; "it advanced within 120ms on a
 * loaded machine" is not, and asserting the second is what made this suite flake.
 */
const ADVANCE_TIMEOUT_MS = 5_000;
/** Ten intervals. A live 20ms timer writes about ten times in here; a dead one writes none. */
const SILENCE_WINDOW_MS = INTERVAL_MS * 10;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function heartbeatOf(jobId: string) {
  const [row] = await statusOf(jobId);
  return row?.heartbeatAt?.getTime() ?? 0;
}

/**
 * Waits until something writes `heartbeatAt`, and fails the test if nothing ever does.
 *
 * Compares for inequality rather than `>`: two writes can land in the same millisecond, so a
 * strict `>` against a fresh timestamp is racy, while `>=` would pass without any write at
 * all. What this suite needs to know is whether the timer is *writing*, and a changed value
 * is exactly that — polling until it changes means the wait is bounded by the assertion, not
 * by a guessed sleep.
 */
async function waitForHeartbeat(jobId: string, previous: number) {
  const deadline = Date.now() + ADVANCE_TIMEOUT_MS;
  for (;;) {
    const at = await heartbeatOf(jobId);
    if (at !== previous) return at;
    if (Date.now() > deadline) {
      throw new Error(`heartbeatAt never moved off ${previous} within ${ADVANCE_TIMEOUT_MS}ms`);
    }
    await sleep(INTERVAL_MS);
  }
}

/**
 * Asserts nothing writes `heartbeatAt` for ten intervals. Only meaningful once the caller has
 * proven the timer was writing — otherwise "no writes" is the trivially true state and the
 * assertion is vacuous.
 */
async function expectHeartbeatSilent(jobId: string) {
  const before = await heartbeatOf(jobId);
  await sleep(SILENCE_WINDOW_MS);
  expect(await heartbeatOf(jobId)).toBe(before);
  return before;
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
  await prisma.project.deleteMany({ where: { id: { in: PROJECTS } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: USER } }).catch(() => undefined);
  await prisma.$executeRaw`DELETE FROM "Workspace" WHERE id = ${WS}`.catch(() => undefined);
  await prisma.$disconnect();
});

describe('job settles on every exit path', () => {
  it('work that throws reaches a terminal status and stops its heartbeat', async () => {
    const job = await startJob('proj_settle_throw');
    const heartbeat = beginJobHeartbeat(job.id, INTERVAL_MS);
    // Prove the timer is alive before the throw, so the silence afterwards means "stopped"
    // rather than "never started".
    await waitForHeartbeat(job.id, await heartbeatOf(job.id));

    await expect(
      (async () => {
        try {
          throw new Error('generation blew up');
        } finally {
          heartbeat.stop();
          await ensureJobSettled(job.id, { errorCode: 'server_restarted' });
        }
      })(),
    ).rejects.toThrow('generation blew up');

    const [row] = await statusOf(job.id);
    expect(row?.status).toBe('ABANDONED');

    // The timer must be dead, or the row would keep looking alive to the reaper.
    await expectHeartbeatSilent(job.id);
  });

  it('a cancelled stream settles the job instead of leaving it RUNNING', async () => {
    const job = await startJob('proj_settle_cancel');
    const heartbeat = beginJobHeartbeat(job.id, INTERVAL_MS);

    // The shape the generation route uses: a detached producer writing into a stream the
    // client reads. `cancel()` is the client going away mid-stream.
    let settled: string | null = null;
    const producer = new ReadableStream<string>({
      async start(controller) {
        controller.enqueue('data: working\n\n');
      },
      async cancel() {
        try {
          heartbeat.stop();
          settled = await ensureJobSettled(job.id, {
            errorCode: 'client_disconnected',
            errorMessage: 'Client disconnected before the generation finished',
          });
        } catch {
          settled = 'error';
        }
      },
    });

    const reader = producer.getReader();
    await reader.read();
    await reader.cancel();

    expect(settled).toBe('settled');
    const [row] = await statusOf(job.id);
    expect(row?.status).toBe('ABANDONED');
    expect(row?.status).not.toBe('RUNNING');
  });

  it('settling twice does not overwrite the first verdict', async () => {
    const job = await startJob('proj_settle_idem');

    await succeedJob(job.id);
    expect((await statusOf(job.id))[0]?.status).toBe('SUCCEEDED');

    // The cleanup path in a `finally` runs after the happy path already settled. Before
    // the guard this flipped a finished generation to FAILED/ABANDONED.
    await failJob(job.id, { errorCode: 'provider_error', errorMessage: 'late cleanup' });
    expect((await statusOf(job.id))[0]?.status).toBe('SUCCEEDED');

    expect(await ensureJobSettled(job.id, { errorCode: 'server_restarted' })).toBe(
      'already_settled',
    );
    expect((await statusOf(job.id))[0]?.status).toBe('SUCCEEDED');
  });

  // These two used to assert the opposite: that an aborted request stopped the
  // heartbeat "so the reaper can see the job". That conflated the person
  // leaving with the work stopping. The generation keeps streaming and
  // persisting server-side after a tab closes, so going quiet marked live work
  // as stale within 90 seconds — the client called a running build failed, and
  // the reaper was free to abandon a job that was still writing files. What
  // makes a finished job visible to the reaper is settling it, which the test
  // below ('stops itself once the job is no longer active') covers.
  it('an aborted request keeps beating while the work continues', async () => {
    const job = await startJob('proj_settle_abort');
    const stale = new Date(Date.now() - HEARTBEAT_STALE_MS * 2);
    await updateJobFields(job.id, { heartbeatAt: stale });

    const controller = new AbortController();
    const heartbeat = beginJobHeartbeat(job.id, {
      intervalMs: INTERVAL_MS,
      signal: controller.signal,
    });
    try {
      const beating = await waitForHeartbeat(job.id, stale.getTime());
      expect(beating).not.toBe(stale.getTime());

      // Client gone, job still RUNNING: the row must go on looking alive.
      controller.abort();
      const afterAbort = await waitForHeartbeat(job.id, beating);
      expect(afterAbort).not.toBe(beating);
      await waitForHeartbeat(job.id, afterAbort);
    } finally {
      heartbeat.stop();
    }
  });

  it('a signal that is already aborted still beats for a running job', async () => {
    const job = await startJob('proj_settle_abort');
    const stale = new Date(Date.now() - HEARTBEAT_STALE_MS * 2);
    await updateJobFields(job.id, { heartbeatAt: stale });

    const heartbeat = beginJobHeartbeat(job.id, {
      intervalMs: INTERVAL_MS,
      signal: AbortSignal.abort(),
    });
    try {
      // A retry can begin after the original request is already gone. The work
      // is real either way, so the row has to be rescued from a timestamp the
      // reaper would otherwise act on.
      const beating = await waitForHeartbeat(job.id, stale.getTime());
      expect(beating).not.toBe(stale.getTime());
    } finally {
      heartbeat.stop();
    }
  });

  it('the heartbeat stops itself once the job is no longer active', async () => {
    const job = await startJob('proj_settle_abort');
    const heartbeat = beginJobHeartbeat(job.id, INTERVAL_MS);
    try {
      await waitForHeartbeat(job.id, await heartbeatOf(job.id));
      await succeedJob(job.id);
      // One more tick may land, then the timer sees a terminal status and clears itself.
      await sleep(INTERVAL_MS * 3);
      await expectHeartbeatSilent(job.id);
      expect((await statusOf(job.id))[0]?.status).toBe('SUCCEEDED');
    } finally {
      heartbeat.stop();
    }
  });
});
