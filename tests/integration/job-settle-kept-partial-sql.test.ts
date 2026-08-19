import '../setup/env';
import { afterAll, describe, expect, it } from 'vitest';
import { testPrismaClient } from '../setup/db';
import {
  claimKeptPartialJob,
  getJob,
  insertJobRaw,
  listReconcileCandidates,
  QUEUE_WAITING_JOB_KINDS,
  releaseKeptPartialClaim,
  settleKeptPartialJob,
  updateJobFields,
} from '@/lib/jobs/store';
import type { JobKind, JobStatus } from '@/generated/prisma';

/**
 * "Keep what was built", and the reaper windows, on real Postgres.
 *
 * Both fixes live entirely inside a WHERE clause, and every other suite that covers them
 * replaces the store with `settleKeptPartialJob.mockResolvedValue(true|false)` — the mock
 * decides the outcome, so the predicate that *is* the fix is unverified. The parse suite
 * only proves the statements are legal SQL: it calls them with an id that matches nothing,
 * which returns zero rows whatever the predicate says.
 *
 * So these cases insert rows in each status and assert the boolean and the row that comes
 * back out. A dropped `AND status IN (...)`, an inverted claim predicate or a `CASE` on the
 * wrong bind fails here and nowhere else.
 */

const prisma = testPrismaClient();

const USER = 'user_job_settle_kept_partial';
const WS = 'ws_job_settle_kept_partial';

/**
 * One project per row. `Project.activeJobId` is single-valued and the reaper reads jobs
 * across the whole table, so sharing a project between fixtures would make these cases
 * depend on each other's rows rather than on the statement under test.
 */
const PROJECTS = [
  'proj_settle_abandoned',
  'proj_settle_failed',
  'proj_settle_running',
  'proj_settle_succeeded',
  'proj_settle_claim',
  'proj_settle_claim_release',
  'proj_claim_running',
  'proj_settle_control',
  'proj_reconcile_running',
  'proj_reconcile_queued_build_fresh',
  'proj_reconcile_queued_build_stale',
  'proj_reconcile_queued_publish',
] as const;

async function seedJob(
  projectId: (typeof PROJECTS)[number],
  status: JobStatus,
  kind: JobKind = 'BUILD',
) {
  await prisma.workspace.upsert({
    where: { id: WS },
    create: { id: WS, storageBytes: 0 },
    update: {},
  });
  await prisma.user.upsert({
    where: { id: USER },
    create: {
      id: USER,
      email: 'job-settle-kept-partial@example.com',
      name: 'Kept Partial',
      role: 'MEMBER',
      passwordHash: 'not-a-real-hash',
    },
    update: {},
  });
  await prisma.project.upsert({
    where: { id: projectId },
    create: {
      id: projectId,
      name: 'Kept partial SQL',
      ownerId: USER,
      initialPrompt: 'kept partial probe',
    },
    update: {},
  });
  return insertJobRaw({ projectId, workspaceId: WS, userId: USER, kind, status });
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

describe('settleKeptPartialJob status guard', () => {
  it('settles an ABANDONED job and records how it ended', async () => {
    const job = await seedJob('proj_settle_abandoned', 'ABANDONED');

    expect(await settleKeptPartialJob(job.id)).toBe(true);

    const settled = await getJob(job.id);
    expect(settled?.status).toBe('SUCCEEDED');
    // `/admin/jobs` and the recovery copy read `lastStep` to say the site was kept from a
    // partial run rather than finished normally.
    expect(settled?.lastStep).toBe('kept_partial');
    expect(settled?.finishedAt).toBeInstanceOf(Date);
  });

  it('settles a FAILED job too', async () => {
    const job = await seedJob('proj_settle_failed', 'FAILED');
    expect(await settleKeptPartialJob(job.id)).toBe(true);
    expect((await getJob(job.id))?.status).toBe('SUCCEEDED');
  });

  it('refuses a RUNNING job and leaves it running', async () => {
    // The defect. The recovery panel opens on the client's 90-second heartbeat watchdog
    // without asking the job, so it is reachable while the generation is still streaming.
    // The unguarded UPDATE settled that row, `succeedJob` then wrote nothing because the
    // job was already terminal, and the person kept a half-written site marked finished.
    const job = await seedJob('proj_settle_running', 'RUNNING');

    expect(await settleKeptPartialJob(job.id)).toBe(false);

    const untouched = await getJob(job.id);
    expect(untouched?.status).toBe('RUNNING');
    expect(untouched?.finishedAt).toBeNull();
    expect(untouched?.lastStep).not.toBe('kept_partial');
  });

  it('refuses a job that is already settled, so a double click keeps one checkpoint', async () => {
    const job = await seedJob('proj_settle_succeeded', 'ABANDONED');
    expect(await settleKeptPartialJob(job.id)).toBe(true);
    expect(await settleKeptPartialJob(job.id)).toBe(false);
  });

  it('a claim is non-terminal, so the settle after it still applies', async () => {
    // Phase 1 used to be the settle itself, which meant a storage failure between the two
    // left the row SUCCEEDED and every retry answering "already settled" — the partial
    // build was then unreachable from any screen.
    const job = await seedJob('proj_settle_claim', 'ABANDONED');

    expect(await claimKeptPartialJob(job.id)).toBe(true);
    const claimed = await getJob(job.id);
    expect(claimed?.status).toBe('ABANDONED');
    // A second click while the first is still storing files gets nothing.
    expect(await claimKeptPartialJob(job.id)).toBe(false);

    expect(await settleKeptPartialJob(job.id)).toBe(true);
    expect((await getJob(job.id))?.status).toBe('SUCCEEDED');
  });

  it('a released claim restores the step the run reached and can be claimed again', async () => {
    const job = await seedJob('proj_settle_claim_release', 'FAILED');
    await updateJobFields(job.id, { lastStep: 'writing_files' });

    expect(await claimKeptPartialJob(job.id)).toBe(true);
    await releaseKeptPartialClaim(job.id, 'writing_files');

    const released = await getJob(job.id);
    expect(released?.status).toBe('FAILED');
    expect(released?.lastStep).toBe('writing_files');
    expect(await claimKeptPartialJob(job.id)).toBe(true);
  });

  it('a claim on a RUNNING job is refused as well', async () => {
    const job = await seedJob('proj_claim_running', 'RUNNING');
    expect(await claimKeptPartialJob(job.id)).toBe(false);
    expect((await getJob(job.id))?.lastStep).toBeNull();
  });

  it('without the status guard the same UPDATE settles a running build', async () => {
    // The negative control. The cases above only mean something if Postgres would happily
    // settle a RUNNING row when the predicate is missing — otherwise "returns false for a
    // RUNNING job" could be true for some unrelated reason and the guard could be deleted
    // without a red test. This is the statement as it was before the fix, minus the
    // `AND status IN (...)`; the guarded version is imported and never re-typed here.
    const job = await seedJob('proj_settle_control', 'RUNNING');
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "GenerationJob"
      SET status = 'SUCCEEDED'::"JobStatus",
          "finishedAt" = NOW(),
          "lastStep" = 'kept_partial',
          "updatedAt" = NOW()
      WHERE id = ${job.id}
      RETURNING id
    `;
    expect(rows).toHaveLength(1);
    expect((await getJob(job.id))?.status).toBe('SUCCEEDED');
  });
});

/**
 * The reaper's two windows, which no mock can express: the long queue window is chosen by
 * a `CASE` on `kind` inside the statement, and giving it to every QUEUED row left a dead
 * publish/import holding its project in BUILDING for eleven minutes.
 */
describe('listReconcileCandidates windows', () => {
  it('measures RUNNING and kind-gated QUEUED rows against the right window', async () => {
    const staleBefore = new Date(Date.now() - 60_000);
    const queuedStaleBefore = new Date(Date.now() - 600_000);
    const queueWaitingKind = QUEUE_WAITING_JOB_KINDS[0]!;
    const ago = (ms: number) => new Date(Date.now() - ms);

    const runningStale = await seedJob('proj_reconcile_running', 'RUNNING');
    await updateJobFields(runningStale.id, { heartbeatAt: ago(120_000) });

    // Parked in the provider queue for two minutes: past the heartbeat window, well inside
    // the ten-minute queue wait. Reaping this is what flipped live builds to "the server
    // restarted" one minute into a legitimate wait.
    const queuedFresh = await seedJob(
      'proj_reconcile_queued_build_fresh',
      'QUEUED',
      queueWaitingKind,
    );
    await updateJobFields(queuedFresh.id, { heartbeatAt: ago(120_000) });

    const queuedStale = await seedJob(
      'proj_reconcile_queued_build_stale',
      'QUEUED',
      queueWaitingKind,
    );
    await updateJobFields(queuedStale.id, { heartbeatAt: ago(900_000) });

    // PUBLISH never queues — it calls `markJobRunning` in the statement after the row is
    // created — so a QUEUED publish means its process is gone and the short window applies.
    const queuedPublish = await seedJob('proj_reconcile_queued_publish', 'QUEUED', 'PUBLISH');
    await updateJobFields(queuedPublish.id, { heartbeatAt: ago(120_000) });
    expect(QUEUE_WAITING_JOB_KINDS).not.toContain('PUBLISH');

    const candidates = await listReconcileCandidates(staleBefore, queuedStaleBefore);
    const ids = new Set(candidates.map((job) => job.id));

    expect(ids.has(runningStale.id)).toBe(true);
    expect(ids.has(queuedStale.id)).toBe(true);
    expect(ids.has(queuedPublish.id)).toBe(true);
    expect(ids.has(queuedFresh.id)).toBe(false);
  });
});
