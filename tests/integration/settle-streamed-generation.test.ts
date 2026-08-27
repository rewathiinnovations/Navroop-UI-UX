import '../setup/env';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { testPrismaClient } from '../setup/db';
import { settleStreamedGeneration, writeMergedSite } from '@/lib/jobs/settle-generation';
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

  it('persists the rest of the batch when one file trips the per-file cap, and reports the guard message', async () => {
    const job = await startBuild();
    // F-028: the 2 MB per-file guard used to have no production caller, so this file
    // landed in Project.lastCode and was re-read on every generation and export.
    const streamedCode = [
      'Here is the site.',
      '```tsx{path=app/page.tsx}',
      'export default function Page() { return null; }',
      '```',
      '```css{path=assets/big.css}',
      'x'.repeat(2_000_001),
      '```',
    ].join('\n');

    const settled = await settleStreamedGeneration({
      jobId: job.id,
      producedFiles: 2,
      streamedCode,
      provider: 'openai',
      model: 'gpt-4o-mini',
    });

    expect(settled.outcome).toBe('succeeded');
    expect(settled.rejectedFiles).toEqual([
      { path: 'assets/big.css', code: 'too_large', message: 'File is too large: assets/big.css' },
    ]);
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: PROJECT },
      select: { lastCode: true },
    });
    expect(project.lastCode).toContain('<file path="app/page.tsx">');
    expect(project.lastCode).not.toContain('big.css');
  });

  it('fails a reply whose only file is binary, without blaming the path', async () => {
    const job = await startBuild();
    const streamedCode = [
      'Here is the logo.',
      '```bin{path=public/logo.png}',
      '\u0000'.repeat(16),
      '```',
    ].join('\n');

    const settled = await settleStreamedGeneration({
      jobId: job.id,
      producedFiles: 1,
      streamedCode,
      provider: 'openai',
      model: 'gpt-4o-mini',
    });

    expect(settled.outcome).toBe('failed');
    expect(settled.errorCode).toBe('no_files_generated');
    // The refusal was about content, so the copy must not claim "unsafe path".
    expect(settled.errorMessage).not.toMatch(/unsafe path/i);
    expect(settled.errorMessage).toMatch(/rejected/i);
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: PROJECT },
      select: { lastCode: true },
    });
    expect(project.lastCode).toBeNull();
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

/**
 * The site write and the content-version bump used to be two statements with no
 * compare-and-set between them. `lastCode` was read at the top of the settle, and an
 * `await resolveImages(...)` — a call out to an image provider that can take many
 * seconds — sat between that read and the write. A concurrent writer landing in that
 * window (a checkpoint restore, keep-partial, or an import persist) was overwritten
 * wholesale, and a crash between the write and `bumpContentVersion` left new code
 * carrying a stale version, so no other viewer's stale-view banner ever fired (F-044).
 *
 * The project lock mostly serialises this, but `acquireLock` is re-entrant for the same
 * user by design, so two operations by one person are not serialised by it at all.
 */
describe('settleStreamedGeneration — the site write is atomic', () => {
  it('bumps contentVersion in the same statement that writes the site', async () => {
    const job = await startBuild();
    const before = await prisma.project.findUniqueOrThrow({
      where: { id: PROJECT },
      select: { contentVersion: true },
    });

    await settleStreamedGeneration({
      jobId: job.id,
      producedFiles: 1,
      streamedCode: ['```tsx{path=app/page.tsx}', 'export const a = 1;', '```'].join('\n'),
    });

    const project = await prisma.project.findUniqueOrThrow({
      where: { id: PROJECT },
      select: { lastCode: true, contentVersion: true, phase: true },
    });
    expect(project.lastCode).toContain('app/page.tsx');
    expect(project.contentVersion).toBe(before.contentVersion + 1);
    expect(project.phase).toBe('COMPLETE');
  });

  it('does not overwrite a write that landed after the read it merged onto', async () => {
    await seed();
    const before = await prisma.project.findUniqueOrThrow({
      where: { id: PROJECT },
      select: { lastCode: true, contentVersion: true },
    });

    // Exactly the window: this is what a restore/keep-partial does while the settle is
    // still inside resolveImages, holding the reading above.
    await prisma.project.update({
      where: { id: PROJECT },
      data: {
        lastCode: '<file path="src/Restored.jsx">\nexport const restored = 1;\n</file>',
        contentVersion: { increment: 1 },
      },
    });

    await writeMergedSite(PROJECT, { 'app/page.tsx': 'export const a = 1;' }, before);

    const after = await prisma.project.findUniqueOrThrow({
      where: { id: PROJECT },
      select: { lastCode: true, contentVersion: true },
    });
    // Both survive: the stale read is discarded and the generated file is merged onto
    // the base that actually won.
    expect(after.lastCode).toContain('src/Restored.jsx');
    expect(after.lastCode).toContain('app/page.tsx');
    expect(after.contentVersion).toBe(before.contentVersion + 2);
  });

  // Control: the retry is a re-read, not a blind overwrite. Writing on a current reading
  // must take exactly one version, or the test above could pass on a function that
  // always re-reads and the compare-and-set would be doing nothing.
  it('control: a write on a current reading takes one version', async () => {
    await seed();
    const before = await prisma.project.findUniqueOrThrow({
      where: { id: PROJECT },
      select: { lastCode: true, contentVersion: true },
    });

    await writeMergedSite(PROJECT, { 'app/page.tsx': 'export const a = 1;' }, before);

    const after = await prisma.project.findUniqueOrThrow({
      where: { id: PROJECT },
      select: { contentVersion: true },
    });
    expect(after.contentVersion).toBe(before.contentVersion + 1);
  });
});

/**
 * `delete_file` and the second half of `rename_file` are only real if the removal
 * survives the persist step. The payload the tool path hands settle is a
 * path→content map, in which an empty string is a legal file — so a deletion
 * cannot be expressed there and travels as its own list. These pin that it
 * arrives, and that it survives the compare-and-set retry, which re-merges onto a
 * fresh base and would otherwise resurrect the file.
 */
describe('settleStreamedGeneration — deletions', () => {
  it('removes a deleted path from the stored site', async () => {
    const job = await startBuild();
    await prisma.project.update({
      where: { id: PROJECT },
      data: {
        lastCode:
          '<file path="app/page.tsx">\nexport const a = 1;\n</file>\n<file path="app/old.tsx">\nexport const old = 1;\n</file>',
      },
    });

    const settled = await settleStreamedGeneration({
      jobId: job.id,
      producedFiles: 1,
      streamedCode: 'Removed the unused route.',
      producedFileMap: { 'app/page.tsx': 'export const a = 2;' },
      deletedPaths: ['app/old.tsx'],
    });

    expect(settled.outcome).toBe('succeeded');
    const after = await prisma.project.findUniqueOrThrow({
      where: { id: PROJECT },
      select: { lastCode: true },
    });
    expect(after.lastCode).toContain('app/page.tsx');
    expect(after.lastCode).toContain('export const a = 2;');
    expect(after.lastCode).not.toContain('app/old.tsx');
  });

  /**
   * A turn that only deleted has no written file. Gating the persist on writes
   * alone skipped the write entirely, so the file stayed on disk while chat
   * reported it gone — and `classifyReplyOutcome` read the turn as no-change.
   */
  it('persists a turn that deleted a file and wrote none', async () => {
    const job = await startBuild();
    await prisma.project.update({
      where: { id: PROJECT },
      data: {
        lastCode:
          '<file path="app/page.tsx">\nexport const a = 1;\n</file>\n<file path="app/gone.tsx">\nexport const gone = 1;\n</file>',
      },
    });

    const settled = await settleStreamedGeneration({
      jobId: job.id,
      producedFiles: 0,
      streamedCode: 'Deleted the unused route.',
      producedFileMap: {},
      deletedPaths: ['app/gone.tsx'],
    });

    expect(settled.outcome).toBe('succeeded');
    const after = await prisma.project.findUniqueOrThrow({
      where: { id: PROJECT },
      select: { lastCode: true },
    });
    expect(after.lastCode).not.toContain('app/gone.tsx');
    // The rest of the site is untouched — a deletion is not a replacement.
    expect(after.lastCode).toContain('app/page.tsx');
  });

  it('a deletion survives losing the compare-and-set once', async () => {
    await seed();
    await prisma.project.update({
      where: { id: PROJECT },
      data: {
        lastCode: '<file path="app/doomed.tsx">\nexport const doomed = 1;\n</file>',
      },
    });
    const before = await prisma.project.findUniqueOrThrow({
      where: { id: PROJECT },
      select: { lastCode: true, contentVersion: true },
    });

    // A concurrent writer lands first, so the settle's reading is stale and the
    // merge is retried against a base that still carries the doomed file.
    await prisma.project.update({
      where: { id: PROJECT },
      data: {
        lastCode:
          '<file path="app/doomed.tsx">\nexport const doomed = 1;\n</file>\n<file path="app/other.tsx">\nexport const other = 1;\n</file>',
        contentVersion: { increment: 1 },
      },
    });

    await writeMergedSite(PROJECT, { 'app/kept.tsx': 'export const kept = 1;' }, before, [
      'app/doomed.tsx',
    ]);

    const after = await prisma.project.findUniqueOrThrow({
      where: { id: PROJECT },
      select: { lastCode: true },
    });
    expect(after.lastCode).not.toContain('app/doomed.tsx');
    expect(after.lastCode).toContain('app/other.tsx');
    expect(after.lastCode).toContain('app/kept.tsx');
  });
});
