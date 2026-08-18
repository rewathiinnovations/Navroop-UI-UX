import '../setup/env';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { testPrismaClient } from '../setup/db';
import { beginJobHeartbeat, succeedJob } from '@/lib/jobs/lifecycle';
import { ensureJobSettled } from '@/lib/jobs/settle';
import { insertJobRaw, updateJobFields } from '@/lib/jobs/store';

/**
 * The URL-import job heartbeat must die with the client connection.
 *
 * `POST /api/projects/[id]/import` used to call `beginJobHeartbeat(importJob.id)`
 * with no `request.signal`. Generate and apply both pass it, for a reason that
 * already bit this codebase: a heartbeat that keeps beating after the client is
 * gone hides the job from the staleness reaper, so an abandoned import survives
 * to the 20-minute timeout while the workspace chat input stays locked.
 *
 * Source half: the route must pass `request.signal` and settle in `finally`
 * (`ensureJobSettled`), the same shape as generate. Behavioural half: that
 * contract — signal-tied heartbeat + last-resort settle — stops the timer and
 * leaves a terminal row, not RUNNING with a fresh `heartbeatAt`.
 */

const prisma = testPrismaClient();

const USER = 'user_import_heartbeat';
const WS = 'ws_import_heartbeat';
const PROJECTS = ['proj_import_hb_abort', 'proj_import_hb_control'];
const ROUTE = 'app/api/projects/[id]/import/route.ts';

const INTERVAL_MS = 25;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
      email: 'import-heartbeat@example.com',
      name: 'Import heartbeat',
      role: 'MEMBER',
      passwordHash: 'not-a-real-hash',
    },
    update: {},
  });
  await prisma.project.upsert({
    where: { id: projectId },
    create: { id: projectId, name: 'Import heartbeat', ownerId: USER, initialPrompt: 'https://example.com' },
    update: {},
  });
}

async function startJob(projectId: string) {
  await seed(projectId);
  const job = await insertJobRaw({
    projectId,
    workspaceId: WS,
    userId: USER,
    kind: 'IMPORT',
    status: 'RUNNING',
  });
  await updateJobFields(job.id, { startedAt: new Date(), heartbeatAt: new Date() });
  return job;
}

function jobRow(jobId: string) {
  return prisma.$queryRaw<Array<{ status: string; heartbeatAt: Date | null; errorCode: string | null }>>`
    SELECT status, "heartbeatAt", "errorCode" FROM "GenerationJob" WHERE id = ${jobId}
  `;
}

async function settledWithin(work: Promise<unknown>, ms: number) {
  return Promise.race([work.then(() => 'settled' as const), wait(ms).then(() => 'pending' as const)]);
}

/**
 * The import route's detached producer, kept close to
 * `app/api/projects/[id]/import/route.ts` after the generate-shaped teardown:
 * heartbeat tied to `signal`, each write raced against abort, `ensureJobSettled`
 * in `finally`, close last and not awaited.
 */
function runDetachedImport(input: { jobId: string; signal: AbortSignal; tieHeartbeatToSignal: boolean }) {
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
  if (input.signal.aborted) noteClientDisconnected('request was already aborted when streaming started');
  input.signal.addEventListener('abort', () => noteClientDisconnected('request aborted'), { once: true });

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
    await Promise.race([written, clientGone]);
  };

  const jobHeartbeat = beginJobHeartbeat(
    input.jobId,
    input.tieHeartbeatToSignal
      ? { intervalMs: INTERVAL_MS, signal: input.signal }
      : { intervalMs: INTERVAL_MS },
  );

  const done = (async () => {
    try {
      for (let index = 0; index < 200; index += 1) {
        if (clientDisconnected) break;
        await writeChunk(encoder.encode(`data: ${JSON.stringify({ type: 'progress', message: `chunk ${index}` })}\n\n`));
      }
      if (clientDisconnected) return;
      await succeedJob(input.jobId);
    } finally {
      jobHeartbeat.stop();
      await ensureJobSettled(input.jobId, {
        errorCode: 'client_disconnected',
        errorMessage: clientDisconnectReason
          ? `Client disconnected before the import finished (${clientDisconnectReason})`
          : 'Client disconnected before the import finished',
      });
      void writer.close().catch(() => undefined);
    }
  })();

  return {
    readable: stream.readable,
    done,
    stopHeartbeat: () => jobHeartbeat.stop(),
  };
}

beforeEach(async () => {
  for (const projectId of PROJECTS) {
    await prisma
      .$executeRaw`DELETE FROM "GenerationJob" WHERE "projectId" = ${projectId}`.catch(() => undefined);
  }
});

afterAll(async () => {
  for (const projectId of PROJECTS) {
    await prisma
      .$executeRaw`DELETE FROM "GenerationJob" WHERE "projectId" = ${projectId}`.catch(() => undefined);
  }
  await prisma.project.deleteMany({ where: { id: { in: PROJECTS } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: USER } }).catch(() => undefined);
  await prisma.$executeRaw`DELETE FROM "Workspace" WHERE id = ${WS}`.catch(() => undefined);
  await prisma.$disconnect();
});

describe('the import route ties the heartbeat to the client', () => {
  const source = readFileSync(resolve(process.cwd(), ROUTE), 'utf8');

  it('passes request.signal into beginJobHeartbeat', () => {
    expect(source).toMatch(
      /beginJobHeartbeat\(\s*importJob\.id\s*,\s*\{\s*signal:\s*request\.signal\s*\}\s*\)/,
    );
  });

  it('settles the job from finally via ensureJobSettled', () => {
    expect(source).toContain("from '@/lib/jobs/settle'");
    expect(source).toMatch(/ensureJobSettled\(\s*importJob\.id/);
    expect(source).toContain("errorCode: 'client_disconnected'");
  });
});

describe('an import whose client disconnects', () => {
  it('stops the heartbeat and leaves the job settled', async () => {
    const job = await startJob('proj_import_hb_abort');
    const controller = new AbortController();
    const run = runDetachedImport({
      jobId: job.id,
      signal: controller.signal,
      tieHeartbeatToSignal: true,
    });

    const reader = run.readable.getReader();
    await reader.read();

    expect(await settledWithin(run.done, 200)).toBe('pending');
    expect((await jobRow(job.id))[0]?.status).toBe('RUNNING');

    controller.abort();
    expect(await settledWithin(run.done, 5_000)).toBe('settled');

    const [row] = await jobRow(job.id);
    expect(row?.status).toBe('ABANDONED');
    expect(row?.status).not.toBe('RUNNING');
    expect(row?.errorCode).toBe('client_disconnected');

    const frozen = row?.heartbeatAt?.getTime() ?? 0;
    await wait(INTERVAL_MS * 5);
    expect((await jobRow(job.id))[0]?.heartbeatAt?.getTime() ?? 0).toBe(frozen);
  });

  it('control: a heartbeat with no signal keeps RUNNING after abort', async () => {
    const job = await startJob('proj_import_hb_control');
    const controller = new AbortController();
    const heartbeat = beginJobHeartbeat(job.id, { intervalMs: INTERVAL_MS });

    try {
      await wait(INTERVAL_MS * 2);
      controller.abort();
      await wait(INTERVAL_MS * 3);

      const [row] = await jobRow(job.id);
      expect(row?.status).toBe('RUNNING');
      const afterAbort = row?.heartbeatAt?.getTime() ?? 0;
      await wait(INTERVAL_MS * 4);
      expect((await jobRow(job.id))[0]?.heartbeatAt?.getTime() ?? 0).toBeGreaterThan(afterAbort);
    } finally {
      heartbeat.stop();
    }
  });
});
