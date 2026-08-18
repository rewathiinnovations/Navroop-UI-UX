import '../setup/env';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { testPrismaClient } from '../setup/db';
import { ensureJobSettled } from '@/lib/jobs/settle';
import { recordJobStepFailure } from '@/lib/jobs/step-failure';
import { getJob, insertJobRaw, updateJobFields } from '@/lib/jobs/store';
import { parseJobSteps } from '@/lib/jobs/types';

/**
 * A terminal job write that fails must be reported, never discarded.
 *
 * The workspace chat's busy state follows the job row, so a lost settle looks exactly like
 * the wedge it is: the input stays locked and the building indicator spins until the
 * 20-minute hard timeout. Both stream routes used to wrap their settle in
 * `.catch(() => undefined)` — non-throwing, which the `finally` needs, but it also threw
 * away the only evidence of why the build hung.
 *
 * Two halves here. The first pins the behaviour the routes now depend on: the failure is
 * persisted where a human will see it, and the row still reaches a terminal status. The
 * second is a source invariant, because the behavioural half would keep passing if someone
 * reintroduced the discard at the call site.
 */

const prisma = testPrismaClient();

const USER = 'user_settle_report';
const WS = 'ws_settle_report';
const PROJECTS = ['proj_settle_report', 'proj_settle_discard'];

const LOST_WRITE = 'syntax error at or near "$1"';

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
      email: 'settle-report@example.com',
      name: 'Settle Report',
      role: 'MEMBER',
      passwordHash: 'not-a-real-hash',
    },
    update: {},
  });
  await prisma.project.upsert({
    where: { id: projectId },
    create: {
      id: projectId,
      name: 'Settle Report',
      ownerId: USER,
      initialPrompt: 'settle report probe',
    },
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

/** The write the routes intend to make, standing in for a `succeedJob` that cannot land. */
async function terminalWriteThatFails(): Promise<never> {
  throw new Error(LOST_WRITE);
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

describe('a failed terminal job write is observable', () => {
  it('is recorded as a job step and still settles the row, without throwing', async () => {
    const job = await startJob('proj_settle_report');
    const cleanup: string[] = [];
    let escaped: unknown = null;

    // The routes' shape: the settle sits in a `try` inside the `finally`, and reporting the
    // failure must neither throw nor stop the cleanup that follows it.
    try {
      try {
        await terminalWriteThatFails();
      } catch (settleError) {
        const detail = settleError instanceof Error ? settleError.message : String(settleError);
        const summary = `Could not record the final job status (succeeded): ${detail}`;
        await recordJobStepFailure(job.id, {
          key: 'settle-job',
          label: 'Record the final job status',
          error: summary,
        });
        // A far simpler write than succeedJob's raw-SQL phase update, so it can land when
        // that one could not — and it reports its verdict either way.
        expect(
          await ensureJobSettled(job.id, {
            errorCode: 'settle_write_failed',
            errorMessage: summary,
          }),
        ).toBe('settled');
      }
    } catch (error) {
      escaped = error;
    } finally {
      cleanup.push('heartbeat-stopped', 'lock-released', 'stream-closed');
    }

    expect(escaped).toBeNull();
    expect(cleanup).toEqual(['heartbeat-stopped', 'lock-released', 'stream-closed']);

    const row = await getJob(job.id);
    // The chat unlocks because the row is terminal, whatever the intended write said.
    expect(row?.status).not.toBe('RUNNING');
    expect(row?.status).toBe('ABANDONED');
    expect(row?.errorCode).toBe('settle_write_failed');

    // Job steps are what the workspace recovery panel and /admin/jobs read, so this is the
    // part a human actually sees.
    const settleStep = parseJobSteps(row?.steps).find((step) => step.key === 'settle-job');
    expect(settleStep?.status).toBe('failed');
    expect(settleStep?.label).toBe('Record the final job status');
    expect(settleStep?.error).toContain('Could not record the final job status');
    expect(settleStep?.error).toContain(LOST_WRITE);
  });

  it('control: discarding the failure leaves the row RUNNING and records nothing', async () => {
    const job = await startJob('proj_settle_discard');

    // Exactly what the routes used to do.
    await terminalWriteThatFails().catch(() => undefined);

    const row = await getJob(job.id);
    // This is the reported symptom: "the build hangs forever".
    expect(row?.status).toBe('RUNNING');
    expect(parseJobSteps(row?.steps).find((step) => step.key === 'settle-job')).toBeUndefined();
  });
});

/**
 * Finds calls of `name(...)` whose closing paren is immediately followed by `.catch(`.
 *
 * Deliberately paren-matched rather than regex-bounded: a settle call spans several lines
 * and contains nested object literals, and a lazy regex either misses it or runs past it.
 */
function callsWithAttachedCatch(source: string, name: string): string[] {
  const found: string[] = [];
  const needle = `${name}(`;
  let from = 0;
  for (;;) {
    const start = source.indexOf(needle, from);
    if (start === -1) break;
    from = start + needle.length;

    let depth = 0;
    let end = -1;
    for (let i = start + needle.length - 1; i < source.length; i += 1) {
      const char = source[i];
      if (char === '(') depth += 1;
      else if (char === ')') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) continue;

    const tail = source.slice(end + 1).trimStart();
    if (tail.startsWith('.catch(')) {
      const line = source.slice(0, start).split('\n').length;
      found.push(`${name} at line ${line}`);
    }
  }
  return found;
}

describe('neither stream route discards a terminal job write', () => {
  const routes = ['app/api/generate-ai-code-stream/route.ts'];

  it.each(routes)('%s settles inside a try/catch that reports', (relativePath) => {
    const source = readFileSync(resolve(process.cwd(), relativePath), 'utf8');
    const discarded = ['succeedJob', 'failJob', 'abandonJob'].flatMap((name) =>
      callsWithAttachedCatch(source, name),
    );
    // `.catch(...)` on a settle is how the diagnosis got lost. These routes use a `try` and
    // report through `recordJobStepFailure` + `ensureJobSettled` instead — both documented
    // as never throwing, so the `finally` stays safe without swallowing anything.
    expect(discarded).toEqual([]);
  });

  it.each(routes)('%s reports lost settles rather than ignoring them', (relativePath) => {
    const source = readFileSync(resolve(process.cwd(), relativePath), 'utf8');
    expect(source).toContain('reportSettleFailure');
    expect(source).toContain('ensureJobSettled');
    // The scanner above would also pass on a route that simply stopped settling, so pin the
    // terminal writes down too. The success write may be made directly or delegated:
    // generate-ai-code-stream hands it to `settleStreamedGeneration`, which decides between
    // succeedJob and failJob on whether the files actually reached a sandbox
    // (lib/jobs/settle-generation.ts, covered by settle-streamed-generation.test.ts). Either
    // shape settles the row; neither leaves it RUNNING.
    expect(source).toMatch(/\bsucceedJob\(|\bsettleStreamedGeneration\(/);
    expect(source).toMatch(/\bfailJob\(/);
  });
});
