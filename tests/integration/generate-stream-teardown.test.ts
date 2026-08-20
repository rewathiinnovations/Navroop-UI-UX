import '../setup/env';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { testPrismaClient } from '../setup/db';
import { beginJobHeartbeat, succeedJob } from '@/lib/jobs/lifecycle';
import { ensureJobSettled } from '@/lib/jobs/settle';
import { insertJobRaw, updateJobFields } from '@/lib/jobs/store';
import { acquireLock, beginLockHeartbeat, releaseLock } from '@/lib/projects/lock';

/**
 * The teardown contract of `app/api/generate-ai-code-stream/route.ts`.
 *
 * That route builds a TransformStream, detaches the work into an un-awaited IIFE and
 * returns the readable. A TransformStream writable has highWaterMark 1, so a client that
 * stops consuming without tearing the stream down applies backpressure and
 * `await writer.write(...)` never settles: the producer parks, its `finally` never runs,
 * and the job sits RUNNING with a fresh heartbeat — which is precisely what makes the
 * staleness reaper skip it. One observed job stayed RUNNING for 12+ minutes and only
 * settled when the server restarted.
 *
 * `runDetachedGeneration` below is that plumbing, kept deliberately close to the route:
 * the same abort race inside the writer, the same order in the `finally`. The assertions
 * are about real rows in the test database, so they fail if the contract regresses.
 */

const prisma = testPrismaClient();

const USER = 'user_gen_teardown';
const WS = 'ws_gen_teardown';
const PROJECTS = [
  'proj_gen_parked',
  'proj_gen_release_first',
  'proj_gen_close_first',
  'proj_gen_no_race',
];

type TeardownOrder = 'release-first' | 'close-first';

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
      email: 'generate-teardown@example.com',
      name: 'Teardown',
      role: 'MEMBER',
      passwordHash: 'not-a-real-hash',
    },
    update: {},
  });
  await prisma.project.upsert({
    where: { id: projectId },
    create: { id: projectId, name: 'Teardown', ownerId: USER, initialPrompt: 'teardown probe' },
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

function jobRow(jobId: string) {
  return prisma.$queryRaw<
    Array<{ status: string; heartbeatAt: Date | null; errorCode: string | null }>
  >`
    SELECT status, "heartbeatAt", "errorCode" FROM "GenerationJob" WHERE id = ${jobId}
  `;
}

function lockRow(projectId: string) {
  return prisma.$queryRaw<Array<{ lockedById: string | null; lockExpiresAt: Date | null }>>`
    SELECT "lockedById", "lockExpiresAt" FROM "Project" WHERE id = ${projectId}
  `;
}

/** The renewal clock. It only advances while a lock heartbeat is still running. */
async function lockExpiry(projectId: string) {
  return (await lockRow(projectId))[0]?.lockExpiresAt?.getTime() ?? 0;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves to 'pending' if the work has not settled within `ms`. */
async function settledWithin(work: Promise<unknown>, ms: number) {
  return Promise.race([
    work.then(() => 'settled' as const),
    wait(ms).then(() => 'pending' as const),
  ]);
}

function runDetachedGeneration(input: {
  jobId: string;
  projectId: string;
  userId: string;
  signal: AbortSignal;
  chunks: number;
  order: TeardownOrder;
  raceAbort?: boolean;
}) {
  const encoder = new TextEncoder();
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();

  let clientDisconnected = false;
  let clientDisconnectReason: string | null = null;
  const noteClientDisconnected = (reason: string) => {
    if (clientDisconnected) return;
    clientDisconnected = true;
    clientDisconnectReason = reason;
  };
  if (input.signal.aborted) noteClientDisconnected('aborted before streaming started');
  input.signal.addEventListener('abort', () => noteClientDisconnected('request aborted'), {
    once: true,
  });

  const clientGone = new Promise<void>((resolve) => {
    if (input.signal.aborted) {
      resolve();
      return;
    }
    input.signal.addEventListener('abort', () => resolve(), { once: true });
  });

  const writeChunk = async (chunk: Uint8Array) => {
    const written = writer
      .write(chunk)
      .catch((error: unknown) =>
        noteClientDisconnected(error instanceof Error ? error.message : String(error)),
      );
    // `raceAbort: false` is the control: it is the old behaviour, where a parked write is
    // the only thing the producer is waiting on.
    if (input.raceAbort === false) {
      await written;
      return;
    }
    await Promise.race([written, clientGone]);
  };

  const sendProgress = async (data: Record<string, unknown>) => {
    if (clientDisconnected) return;
    await writeChunk(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  };

  const jobHeartbeat = beginJobHeartbeat(input.jobId, { intervalMs: 25, signal: input.signal });
  const lockHeartbeat = beginLockHeartbeat(input.projectId, input.userId, 25);
  let lockHeld = true;
  const releaseGenerationLock = async () => {
    lockHeartbeat.stop();
    if (!lockHeld) return;
    lockHeld = false;
    await releaseLock(input.projectId, input.userId);
  };

  const done = (async () => {
    try {
      for (let index = 0; index < input.chunks; index += 1) {
        if (clientDisconnected) break;
        await sendProgress({ type: 'stream', text: `chunk ${index}`, raw: true });
      }
      if (clientDisconnected) return;
      await succeedJob(input.jobId);
    } finally {
      jobHeartbeat.stop();
      await ensureJobSettled(input.jobId, {
        errorCode: 'client_disconnected',
        errorMessage: clientDisconnectReason
          ? `Client disconnected before the generation finished (${clientDisconnectReason})`
          : 'Client disconnected before the generation finished',
      });
      if (input.order === 'release-first') {
        await releaseGenerationLock();
        // Not awaited, exactly as in the route: `close()` waits for queued chunks to drain
        // and a client that stopped reading never drains them.
        void writer.close().catch(() => undefined);
      } else {
        // The old order. `writer.close()` rejects on a cancelled readable, so the release
        // never runs and `lockHeartbeat` keeps renewing the project lock forever.
        await writer.close();
        await releaseGenerationLock();
      }
    }
  })();

  return {
    readable: stream.readable,
    done,
    /**
     * False when the run finished without ever reaching `releaseGenerationLock` — the
     * `close-first` leak, observed directly instead of inferred from a renewal.
     */
    lockReleased: () => !lockHeld,
    /** Test cleanup only: the `close-first` control deliberately leaks these timers. */
    stopHeartbeats: () => {
      jobHeartbeat.stop();
      lockHeartbeat.stop();
    },
  };
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

describe('generate-ai-code-stream teardown', () => {
  it('a client that stops reading no longer leaves the job RUNNING', async () => {
    const projectId = 'proj_gen_parked';
    const job = await startJob(projectId);
    expect((await acquireLock(projectId, USER, 'generation')).ok).toBe(true);

    const controller = new AbortController();
    const run = runDetachedGeneration({
      jobId: job.id,
      projectId,
      userId: USER,
      signal: controller.signal,
      chunks: 200,
      order: 'release-first',
    });

    // One read, then the client goes quiet without cancelling. Each read releases exactly
    // one write, so the producer is now parked inside `writer.write` — the shape that
    // wedges it. The stream is deliberately left un-cancelled.
    const reader = run.readable.getReader();
    await reader.read();

    expect(await settledWithin(run.done, 200)).toBe('pending');
    expect((await jobRow(job.id))[0]?.status).toBe('RUNNING');

    // Next aborts the request signal when the connection drops. That is the only signal
    // the parked producer gets, and it has to be enough.
    controller.abort();
    expect(await settledWithin(run.done, 5_000)).toBe('settled');

    const [row] = await jobRow(job.id);
    expect(row?.status).toBe('ABANDONED');
    expect(row?.status).not.toBe('RUNNING');
    expect(row?.errorCode).toBe('client_disconnected');

    // The heartbeat has to be dead too: a fresh heartbeatAt is what hid the row from the
    // staleness reaper for 12 minutes.
    const frozen = row?.heartbeatAt?.getTime() ?? 0;
    await wait(120);
    expect((await jobRow(job.id))[0]?.heartbeatAt?.getTime() ?? 0).toBe(frozen);

    // And the project lock is gone, so the next request is not refused with a 409.
    expect((await lockRow(projectId))[0]?.lockedById).toBeNull();
  });

  it('control: without the abort race the producer parks forever and the job stays RUNNING', async () => {
    const projectId = 'proj_gen_no_race';
    const job = await startJob(projectId);
    expect((await acquireLock(projectId, USER, 'generation')).ok).toBe(true);

    const controller = new AbortController();
    const run = runDetachedGeneration({
      jobId: job.id,
      projectId,
      userId: USER,
      signal: controller.signal,
      chunks: 200,
      order: 'release-first',
      raceAbort: false,
    });

    const reader = run.readable.getReader();
    await reader.read();
    // Let the producer park inside the next write before the client goes away.
    await wait(100);
    controller.abort();

    // This is the 20-minute wedge: aborting does nothing, because the only thing the
    // producer awaits is a write no reader will ever drain.
    expect(await settledWithin(run.done, 500)).toBe('pending');
    expect((await jobRow(job.id))[0]?.status).toBe('RUNNING');

    run.stopHeartbeats();
    await releaseLock(projectId, USER);
  });

  it('releases the project lock even though closing a cancelled stream rejects', async () => {
    const projectId = 'proj_gen_release_first';
    const job = await startJob(projectId);
    expect((await acquireLock(projectId, USER, 'generation')).ok).toBe(true);

    const controller = new AbortController();
    const run = runDetachedGeneration({
      jobId: job.id,
      projectId,
      userId: USER,
      signal: controller.signal,
      chunks: 200,
      order: 'release-first',
    });

    // Cancelling errors the writable, so `writer.close()` in the `finally` rejects.
    await run.readable.cancel('client went away');
    controller.abort();
    expect(await settledWithin(run.done, 5_000)).toBe('settled');

    expect((await jobRow(job.id))[0]?.status).toBe('ABANDONED');
    expect((await lockRow(projectId))[0]?.lockedById).toBeNull();

    // Releasing is also what stops `lockHeartbeat`. Re-hold the lock and its expiry must
    // stand still: nothing is renewing it any more.
    expect(run.lockReleased()).toBe(true);
    expect((await acquireLock(projectId, USER, 'generation')).ok).toBe(true);
    const heldUntil = await lockExpiry(projectId);
    await wait(150);
    expect(await lockExpiry(projectId)).toBe(heldUntil);
    await releaseLock(projectId, USER);
  });

  it('control: closing before releasing leaks the lock, which is why the order changed', async () => {
    const projectId = 'proj_gen_close_first';
    const job = await startJob(projectId);
    expect((await acquireLock(projectId, USER, 'generation')).ok).toBe(true);

    const controller = new AbortController();
    const run = runDetachedGeneration({
      jobId: job.id,
      projectId,
      userId: USER,
      signal: controller.signal,
      chunks: 200,
      order: 'close-first',
    });

    await run.readable.cancel('client went away');
    controller.abort();
    // The rejected close escapes the `finally`, which is also why the detached IIFE needs
    // a `.catch()` — this used to be an unhandled rejection.
    await expect(run.done).rejects.toThrow();

    // The job still settled, because the settle runs before the close…
    expect((await jobRow(job.id))[0]?.status).toBe('ABANDONED');
    // …but the release was skipped, so nothing in the run stopped `lockHeartbeat`: the
    // timer is still armed after the work is over, which is the leak the reorder removes.
    // Asserted on the run itself rather than inferred from a renewal, because what the
    // renewal does next changed: the settle above gave the project lock back
    // (`abandonJob` → `releaseLockQuietly`), so the next renew matches no row, reports the
    // loss and stops the interval itself (F-730). That bounds the leak; it does not make
    // the close-first order correct, which is what this control is for.
    expect(run.lockReleased()).toBe(false);
    // Long enough for several 25ms renew ticks, so the loss has certainly been observed
    // before the lock is taken again — otherwise the leaked timer would renew the *new*
    // hold, which is the corruption F-730 is about.
    await wait(200);
    expect((await acquireLock(projectId, USER, 'generation')).ok).toBe(true);
    const heldUntil = await lockExpiry(projectId);
    await wait(150);
    expect(await lockExpiry(projectId)).toBe(heldUntil);

    run.stopHeartbeats();
    await releaseLock(projectId, USER);
  });
});
