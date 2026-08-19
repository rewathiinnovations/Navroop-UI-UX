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
    },
    update: {
      lastCode: null,
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
    // The model replies in fenced blocks; lastCode is stored as <file> blocks.
    const streamedCode = [
      'Here is the page.',
      '```tsx{path=app/page.tsx}',
      'export default function Page() { return null; }',
      '```',
    ].join('\n');

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
    expect(project.lastCode).toBe(
      [
        '<file path="app/page.tsx">',
        'export default function Page() { return null; }',
        '</file>',
      ].join('\n'),
    );
    expect(project.phase).toBe('COMPLETE');
  });

  it('does not settle SUCCEEDED+COMPLETE with lastCode null when nothing parsed', async () => {
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
    expect(row?.errorCode).toBe('no_files_generated');
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

  it('fails an edit whose every path was refused, instead of succeeding on the site already there', async () => {
    const job = await startBuild();
    // The project already has a site, which is what hid this: `hasSite` was true from the
    // existing lastCode, so a reply whose every path was refused skipped the write block,
    // skipped the no-files failure, and reached succeedJob. Chat reported the change as made
    // and lastCode had not moved — only a log line recorded it.
    const existing = [
      '<file path="src/App.jsx">',
      'export default function App() { return null; }',
      '</file>',
    ].join('\n');
    await prisma.project.update({ where: { id: PROJECT }, data: { lastCode: existing } });

    const streamedCode = [
      'Updated the config.',
      '```env{path=../../.env}',
      'AUTH_SECRET=leaked',
      '```',
      '```ts{path=C:/windows/system32/evil.ts}',
      'export const evil = 1;',
      '```',
    ].join('\n');

    const settled = await settleStreamedGeneration({
      jobId: job.id,
      producedFiles: 2,
      streamedCode,
      provider: 'openai',
      model: 'gpt-4o-mini',
    });

    expect(settled.outcome).toBe('failed');
    expect(settled.errorCode).toBe('no_files_generated');
    expect(settled.errorMessage).toMatch(/unsafe path/i);
    const [row] = await prisma.$queryRaw<Array<{ status: string; errorCode: string | null }>>`
      SELECT status, "errorCode" FROM "GenerationJob" WHERE id = ${job.id}
    `;
    expect(row?.status).toBe('FAILED');
    expect(row?.errorCode).toBe('no_files_generated');
    // The site that was already there is untouched, not overwritten and not deleted.
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: PROJECT },
      select: { lastCode: true },
    });
    expect(project.lastCode).toBe(existing);
  });
});

describe('settleStreamedGeneration — stack mismatch', () => {
  it('fails the job and does not persist code the stack cannot render', async () => {
    const job = await startBuild();
    // The live Ember & Oak REACT build: gpt-4o-mini wrote a lone Next.js
    // app/page.tsx for a Vite project; it settled SUCCEEDED and the sandbox
    // then died booting it (npm ENOENT, no package.json).
    // The model replies in fenced blocks; lastCode is stored as <file> blocks.
    const streamedCode = [
      'Here is the page.',
      '```tsx{path=app/page.tsx}',
      'export default function Page() { return null; }',
      '```',
    ].join('\n');

    const settled = await settleStreamedGeneration({
      jobId: job.id,
      producedFiles: 1,
      streamedCode,
      stackMismatchReason:
        "The generated files don't match the React (Vite) project layout (expected src/App.jsx; got app/page.tsx).",
    });

    expect(settled.outcome).toBe('failed');
    expect(settled.errorCode).toBe('stack_mismatch');
    const [row] = await prisma.$queryRaw<Array<{ status: string; errorCode: string | null }>>`
      SELECT status, "errorCode" FROM "GenerationJob" WHERE id = ${job.id}
    `;
    expect(row?.status).toBe('FAILED');
    expect(row?.errorCode).toBe('stack_mismatch');
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: PROJECT },
      select: { lastCode: true },
    });
    expect(project.lastCode).toBeNull();
  });
});
