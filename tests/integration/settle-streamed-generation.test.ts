import '../setup/env';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { testPrismaClient } from '../setup/db';
import { settleStreamedGeneration } from '@/lib/jobs/settle-generation';
import { insertJobRaw, updateJobFields } from '@/lib/jobs/store';
import { offersRecoveryRetry } from '@/lib/jobs/copy';

/**
 * Mutation: a BUILD stream that produced files must not settle
 * SUCCEEDED + COMPLETE + lastCode null when persist/sandbox missed.
 *
 * The live Vaidya build (job eJO24Bp_ccEnDV4Opr5cJ) did exactly that:
 * 11 streamed files, Modal never READY, persist never ran, chat said
 * Generation complete, and Try again was hidden because the job was SUCCEEDED.
 */

const prisma = testPrismaClient();

const USER = 'user_settle_stream';
const WS = 'ws_settle_stream';
const PROJECT = 'proj_settle_stream_vaidya';

async function seed() {
  await prisma.workspace.upsert({
    where: { id: WS },
    create: { id: WS, storageBytes: 0 },
    update: {},
  });
  await prisma.user.upsert({
    where: { id: USER },
    create: {
      id: USER,
      email: 'settle-stream@example.com',
      name: 'Settle stream',
      role: 'MEMBER',
      passwordHash: 'not-a-real-hash',
    },
    update: {},
  });
  await prisma.project.upsert({
    where: { id: PROJECT },
    create: {
      id: PROJECT,
      name: 'Vaidya',
      ownerId: USER,
      initialPrompt: 'Build Vaidya',
      lastCode: null,
      sandboxStatus: 'FAILED',
    },
    update: {
      lastCode: null,
      sandboxStatus: 'FAILED',
      phase: 'BUILDING',
      generationStatus: 'generating',
      progressMessage: null,
      activePreviewBuildId: null,
      previewUrl: null,
    },
  });
}

async function startBuild() {
  await seed();
  const job = await insertJobRaw({
    projectId: PROJECT,
    workspaceId: WS,
    userId: USER,
    kind: 'BUILD',
    status: 'RUNNING',
    inputPrompt: 'Build Vaidya',
  });
  await updateJobFields(job.id, {
    startedAt: new Date(),
    heartbeatAt: new Date(),
    filesWritten: 11,
    lastStep: 'app/sitemap.ts',
  });
  await prisma.$executeRaw`
    UPDATE "Project" SET "activeJobId" = ${job.id} WHERE id = ${PROJECT}
  `;
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

describe('settleStreamedGeneration — stream files are not a finished site', () => {
  it('persists the streamed code server-side and succeeds, even with the sandbox dead', async () => {
    const job = await startBuild();
    const streamedCode = '<file path="app/page.tsx">export default function Page() { return null; }</file>';

    const settled = await settleStreamedGeneration({
      jobId: job.id,
      producedFiles: 1,
      streamedCode,
      provider: 'openai',
      model: 'gpt-4o-mini',
    });

    // The server held the whole site when the stream ended — a closed tab or
    // a sandbox stuck mid-boot must not lose it (the Atelier Homes build:
    // job SUCCEEDED, lastCode empty, phase PLANNING forever).
    expect(settled.outcome).toBe('succeeded');
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: PROJECT },
      select: { lastCode: true, phase: true },
    });
    expect(project.lastCode).toBe(streamedCode);
    expect(project.phase).toBe('COMPLETE');
  });


  it('does not settle SUCCEEDED+COMPLETE with lastCode null when sandbox/persist missed', async () => {
    const job = await startBuild();

    const settled = await settleStreamedGeneration({
      jobId: job.id,
      producedFiles: 11,
      provider: 'google',
      model: 'gemini-2.5-flash',
    });

    const [row] = await prisma.$queryRaw<
      Array<{ status: string; errorCode: string | null; filesWritten: number }>
    >`
      SELECT status, "errorCode", "filesWritten" FROM "GenerationJob" WHERE id = ${job.id}
    `;
    const [project] = await prisma.$queryRaw<
      Array<{ phase: string; lastCode: string | null; generationStatus: string | null }>
    >`
      SELECT phase, "lastCode", "generationStatus" FROM "Project" WHERE id = ${PROJECT}
    `;

    expect(settled.outcome).toBe('failed');
    expect(row?.status).not.toBe('SUCCEEDED');
    expect(row?.status).toBe('FAILED');
    expect(row?.errorCode).toBe('sandbox_unavailable');
    expect(row?.filesWritten).toBe(11);
    expect(project?.lastCode).toBeNull();
    expect(project?.phase).not.toBe('COMPLETE');
    expect(project?.phase).toBe('PLANNING');
    expect(
      row?.status === 'SUCCEEDED' && project?.phase === 'COMPLETE' && project?.lastCode == null,
    ).toBe(false);

    expect(row?.status === 'FAILED' || row?.status === 'ABANDONED').toBe(true);
    expect(
      offersRecoveryRetry({
        kind: 'BUILD',
        errorCode: row?.errorCode,
        errorMessage: settled.errorMessage,
      }),
    ).toBe(true);
  });
});
