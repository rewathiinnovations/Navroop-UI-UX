import '../setup/env';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { testPrismaClient } from '../setup/db';
import { succeedJob } from '@/lib/jobs/lifecycle';
import { insertJobRaw, updateJobFields } from '@/lib/jobs/store';
import { isChatRecoveryStatus } from '@/lib/jobs/chat-ui';

/**
 * A conversational turn in build mode ends the job as done-with-no-changes.
 *
 * Live incident, request `PhQfrFGYDYZo`: a 33-file BUILD had succeeded, the user typed
 * "hello", the model answered in prose, and the FOLLOWUP was failed `no_files_generated`
 * with a red recovery panel over it. The answer path in generate-ai-code-stream settles
 * through `succeedJob` for exactly this reason — and deliberately not through
 * `settleStreamedGeneration`, which fails `no_files_generated` whenever the project has no
 * site yet, which would re-create the same false failure for a first-message "hello".
 *
 * The trap on that path is the phase. The job set the project to BUILDING; an answer has to
 * put back the phase the evidence supports, never a blanket COMPLETE — an empty project
 * claiming a finished site sends the preview looking for something to show. `succeedJob`
 * resolves it through `resumablePhaseFromEvidence` (lastCode / checkpoints), and these tests
 * pin both ends of that decision.
 */

const prisma = testPrismaClient();

const USER = 'user_answer_turn';
const WS = 'ws_answer_turn';
const PROJECT = 'proj_answer_turn';

const SITE_LAST_CODE = '<file path="app/page.tsx">export default function Page() {}</file>';

async function seed(lastCode: string | null) {
  await prisma.workspace.upsert({
    where: { id: WS },
    create: { id: WS, storageBytes: 0 },
    update: {},
  });
  await prisma.user.upsert({
    where: { id: USER },
    create: {
      id: USER,
      email: 'answer-turn@example.com',
      name: 'Answer turn',
      role: 'MEMBER',
      passwordHash: 'not-a-real-hash',
    },
    update: {},
  });
  await prisma.project.upsert({
    where: { id: PROJECT },
    create: {
      id: PROJECT,
      name: 'Answer turn',
      ownerId: USER,
      initialPrompt: 'Landing page build',
      lastCode,
    },
    update: {
      lastCode,
      // What the running FOLLOWUP left behind: the answer turn has to move it off this.
      phase: 'BUILDING',
      generationStatus: 'generating',
    },
  });
}

/** A RUNNING FOLLOWUP, as the route holds it when the model answers with prose. */
async function startFollowup(lastCode: string | null) {
  await seed(lastCode);
  const job = await insertJobRaw({
    projectId: PROJECT,
    workspaceId: WS,
    userId: USER,
    kind: 'FOLLOWUP',
    status: 'RUNNING',
    inputPrompt: 'hello',
  });
  await updateJobFields(job.id, { startedAt: new Date(), heartbeatAt: new Date() });
  await prisma.$executeRaw`UPDATE "Project" SET "activeJobId" = ${job.id} WHERE id = ${PROJECT}`;
  return job;
}

beforeEach(async () => {
  await prisma.$executeRaw`DELETE FROM "GenerationJob" WHERE "projectId" = ${PROJECT}`.catch(
    () => undefined,
  );
  await prisma.checkpoint.deleteMany({ where: { projectId: PROJECT } }).catch(() => undefined);
});

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM "GenerationJob" WHERE "projectId" = ${PROJECT}`.catch(
    () => undefined,
  );
  await prisma.checkpoint.deleteMany({ where: { projectId: PROJECT } }).catch(() => undefined);
  await prisma.project.deleteMany({ where: { id: PROJECT } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: USER } }).catch(() => undefined);
  await prisma.$executeRaw`DELETE FROM "Workspace" WHERE id = ${WS}`.catch(() => undefined);
  await prisma.$disconnect();
});

describe('an answer turn settles SUCCEEDED with the phase the evidence supports', () => {
  it('lands on COMPLETE when the project already has a site', async () => {
    const job = await startFollowup(SITE_LAST_CODE);

    await succeedJob(job.id, { tokensIn: 900, tokensOut: 120, provider: 'deepseek' });

    const settled = await prisma.$queryRaw<
      { status: string; errorCode: string | null; creditsChargedAt: Date | null }[]
    >`SELECT status, "errorCode", "creditsChargedAt" FROM "GenerationJob" WHERE id = ${job.id}`;
    expect(settled[0].status).toBe('SUCCEEDED');
    // No `no_files_generated`, so RecoveryPanel has nothing to draw: chat recovery renders
    // for ABANDONED / FAILED / CANCELLED only (`isChatRecoveryStatus`).
    expect(settled[0].errorCode).toBeNull();
    expect(isChatRecoveryStatus(settled[0].status)).toBe(false);
    // The turn is part of the job that was already charged once at markJobRunning. Settling
    // it must not stamp a second charge.
    expect(settled[0].creditsChargedAt).toBeNull();

    const project = await prisma.project.findUniqueOrThrow({
      where: { id: PROJECT },
      select: { phase: true, generationStatus: true, lastCode: true },
    });
    expect(project.phase).toBe('COMPLETE');
    expect(project.generationStatus).toBe('ready');
    // An answer changed nothing, so the site it answered about is untouched.
    expect(project.lastCode).toBe(SITE_LAST_CODE);
  });

  it('lands back on PLANNING when there is no site, instead of claiming one', async () => {
    const job = await startFollowup(null);

    await succeedJob(job.id, { tokensIn: 300, tokensOut: 40, provider: 'deepseek' });

    const settled = await prisma.$queryRaw<
      { status: string; errorCode: string | null }[]
    >`SELECT status, "errorCode" FROM "GenerationJob" WHERE id = ${job.id}`;
    expect(settled[0].status).toBe('SUCCEEDED');
    expect(settled[0].errorCode).toBeNull();

    const project = await prisma.project.findUniqueOrThrow({
      where: { id: PROJECT },
      select: { phase: true, generationStatus: true, lastCode: true },
    });
    // Hard-coding COMPLETE here is the bug this asserts against: an empty project would
    // insist it has a finished site and the preview would go looking for it.
    expect(project.phase).toBe('PLANNING');
    expect(project.generationStatus).toBe('idle');
    expect(project.lastCode).toBeNull();
  });
});
