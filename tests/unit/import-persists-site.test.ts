/**
 * A URL import must store the site itself, server-side.
 *
 * The import flow never reaches /api/generate-ai-code-stream —
 * GenerationWorkspace skips the generation stream when the import already
 * produced `filesXml` — so `settleStreamedGeneration`, the writer that owns
 * `lastCode` for a streamed build, never runs here. When the browser's terminal
 * PATCH stopped carrying `lastCode` ("the server owns the site") an import
 * finished SUCCEEDED with `lastCode` NULL: phase COMPLETE, a checkpoint
 * snapshotted from that null, and a project that was blank forever.
 *
 * These cases pin the replacement writer, first on its own and then through the
 * route handler that has to call it on every entry path. No client PATCH is
 * involved anywhere in them: the only thing that touches the project row is the
 * import route's own call. `@/lib/db` is mocked, so no database is needed.
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UrlImportResult } from '@/lib/import/types';
import type * as LockModule from '@/lib/projects/lock';
import type * as UrlGuardModule from '@/lib/security/url-guard';

const db = vi.hoisted(() => ({
  projectUpdate: vi.fn(async () => ({})),
  projectFindFirst: vi.fn(),
  projectFindUnique: vi.fn(),
  executeRaw: vi.fn(async () => 1),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    project: {
      update: db.projectUpdate,
      findFirst: db.projectFindFirst,
      findUnique: db.projectFindUnique,
    },
    $executeRaw: db.executeRaw,
  },
}));

const auth = vi.hoisted(() => ({ getSessionUser: vi.fn() }));
vi.mock('@/lib/auth', () => ({ getSessionUser: auth.getSessionUser }));

const plans = vi.hoisted(() => ({ checkCredits: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/lib/plans/limits', () => plans);

// Only the DNS-and-network half is replaced; `UnsafeUrlError` stays real, because
// `importJobErrorCode` decides on it.
const guard = vi.hoisted(() => ({ assertSafeUrl: vi.fn(async () => undefined) }));
vi.mock('@/lib/security/url-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof UrlGuardModule>()),
  assertSafeUrl: guard.assertSafeUrl,
}));

// `bumpContentVersion` stays real (it runs on the mocked `$executeRaw`); the hold is
// what these cases drive. Its `release` is what the route is judged on — a re-entered
// hold hands back a release that must do nothing, and the real one owns the renew timer.
const lock = vi.hoisted(() => ({
  holdProjectLock: vi.fn(),
  release: vi.fn(async () => undefined),
  // Spied, not driven: the route must reach these only through the hold.
  releaseLock: vi.fn(async () => ({ ok: true })),
  beginLockHeartbeat: vi.fn(() => ({ stop: vi.fn() })),
}));
vi.mock('@/lib/projects/lock', async (importOriginal) => ({
  ...(await importOriginal<typeof LockModule>()),
  holdProjectLock: lock.holdProjectLock,
  releaseLock: lock.releaseLock,
  beginLockHeartbeat: lock.beginLockHeartbeat,
}));

const jobs = vi.hoisted(() => ({
  createOrReuseJob: vi.fn(),
  markJobRunning: vi.fn(async () => ({})),
  succeedJob: vi.fn(async () => ({})),
  failJob: vi.fn(async () => ({})),
  beginJobHeartbeat: vi.fn(),
  jobHeartbeatStop: vi.fn(),
}));
vi.mock('@/lib/jobs/lifecycle', () => jobs);
vi.mock('@/lib/jobs/store', () => ({ updateJobFields: vi.fn(async () => ({})) }));
vi.mock('@/lib/jobs/settle', () => ({ ensureJobSettled: vi.fn(async () => 'already_settled') }));

const run = vi.hoisted(() => ({ runProjectUrlImport: vi.fn() }));
vi.mock('@/lib/import/run', () => run);

// Fulfilment is wiring under test, not behaviour: the real module reaches image
// providers and storage at import time. Default passthrough in beforeEach.
const fulfill = vi.hoisted(() => ({ fulfillNeedImages: vi.fn() }));
vi.mock('@/lib/assets/fulfill', () => fulfill);

const afterPersist = vi.hoisted(() => ({
  createCheckpointAfterGeneration: vi.fn(),
  capturePreviewAfterGeneration: vi.fn(),
  buildPreviewForProject: vi.fn(),
  writeMergedSite: vi.fn(),
}));
vi.mock('@/lib/checkpoints/actions', () => ({
  createCheckpointAfterGeneration: afterPersist.createCheckpointAfterGeneration,
}));
vi.mock('@/lib/preview/after-generation', () => ({
  capturePreviewAfterGeneration: afterPersist.capturePreviewAfterGeneration,
}));
vi.mock('@/lib/preview/production', () => ({
  buildPreviewForProject: afterPersist.buildPreviewForProject,
}));
vi.mock('@/lib/jobs/settle-generation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/jobs/settle-generation')>();
  return {
    ...actual,
    writeMergedSite: afterPersist.writeMergedSite,
  };
});

// Dynamic, not static: every `vi.mock` above has to be registered before the
// module graph under test is evaluated.
const { persistImportedSite } = await import('@/lib/import/persist');
const { IMPORT_NO_FILES_MESSAGE } = await import('@/lib/import/copy');
const { importJobErrorCode } = await import('@/lib/import/errors');
const { getCurrentProjectFiles } = await import('@/lib/github/current-files');
const { POST } = await import('@/app/api/projects/[id]/import/route');
const { ensureJobSettled } = await import('@/lib/jobs/settle');

const PROJECT = 'p-import';
const OWNER = 'u-owner';
const SOURCE_URL = 'https://example.com';
const JOB_ID = 'job_import_1';

function written() {
  const call = db.projectUpdate.mock.calls[0]?.[0] as {
    where: { id: string };
    data: { lastCode: string; phase: string };
  };
  return call;
}

function storedFiles() {
  return getCurrentProjectFiles({ lastCode: written().data.lastCode });
}

beforeEach(() => {
  vi.clearAllMocks();
  db.projectUpdate.mockResolvedValue({});
  db.executeRaw.mockResolvedValue(1);
  lock.release.mockResolvedValue(undefined);
  lock.holdProjectLock.mockResolvedValue({ ok: true, reentered: false, release: lock.release });
  jobs.beginJobHeartbeat.mockReturnValue({ stop: jobs.jobHeartbeatStop });
  jobs.createOrReuseJob.mockResolvedValue({ id: JOB_ID, status: 'QUEUED' });
  jobs.markJobRunning.mockResolvedValue({ id: JOB_ID, status: 'RUNNING' });
  plans.checkCredits.mockResolvedValue({ ok: true });
  guard.assertSafeUrl.mockResolvedValue(undefined);
  auth.getSessionUser.mockResolvedValue({ id: OWNER, role: 'MEMBER' });
  fulfill.fulfillNeedImages.mockImplementation(async ({ files }) =>
    Object.assign([...files], { unfulfilled: [] }),
  );
  afterPersist.createCheckpointAfterGeneration.mockResolvedValue({
    id: 'ckpt_import_1',
    createdAt: new Date('2026-08-28T00:00:00.000Z'),
  });
  afterPersist.capturePreviewAfterGeneration.mockResolvedValue({ notice: null });
  afterPersist.buildPreviewForProject.mockResolvedValue({ ok: true });
  afterPersist.writeMergedSite.mockImplementation(async (_id, files) => {
    db.projectUpdate({
      where: { id: PROJECT },
      data: {
        lastCode: Object.entries(files)
          .map(([path, content]) => `<file path="${path}">\n${content}\n</file>`)
          .join('\n'),
        phase: 'COMPLETE',
      },
    });
  });
  const projectRow = {
    id: PROJECT,
    ownerId: OWNER,
    phase: 'PLANNING' as const,
    stack: 'NEXTJS',
    designDirection: null,
    initialPrompt: SOURCE_URL,
    importSource: null,
    lastCode: null,
    contentVersion: 0,
  };
  db.projectFindFirst.mockResolvedValue(projectRow);
  db.projectFindUnique.mockResolvedValue(projectRow);
});

describe('persistImportedSite', () => {
  it('writes the imported files as lastCode, marks the project COMPLETE and bumps contentVersion', async () => {
    const result = await persistImportedSite({
      projectId: PROJECT,
      filesXml:
        '<file path="src/App.tsx">export default function App() { return <Hero /> }</file>\n\n' +
        '<file path="src/components/Hero.tsx">export const Hero = () => <h1>Hi</h1></file>',
    });

    expect(result.fileCount).toBe(2);
    expect(written().where).toEqual({ id: PROJECT });
    expect(written().data.phase).toBe('COMPLETE');
    // Round-trips through the one reader the preview, the Code tab, the ZIP
    // export and the checkpoint snapshot all use.
    expect(storedFiles()).toEqual({
      'src/App.tsx': 'export default function App() { return <Hero /> }',
      'src/components/Hero.tsx': 'export const Hero = () => <h1>Hi</h1>',
    });
    // CAS + increment live in writeMergedSite, not a separate bump after an
    // unconditional update (F-044).
    expect(afterPersist.writeMergedSite).toHaveBeenCalledTimes(1);
    expect(afterPersist.writeMergedSite.mock.calls[0]?.[2]).toMatchObject({
      contentVersion: 0,
    });
  });

  it('writes a checkpoint and captures preview in-process after the site lands', async () => {
    await persistImportedSite({
      projectId: PROJECT,
      filesXml: '<file path="src/App.tsx">export default function App() { return null }</file>',
    });

    expect(afterPersist.writeMergedSite).toHaveBeenCalled();
    expect(afterPersist.createCheckpointAfterGeneration).toHaveBeenCalledWith(
      PROJECT,
      expect.objectContaining({ previousPhase: 'PLANNING' }),
    );
    expect(afterPersist.capturePreviewAfterGeneration).toHaveBeenCalled();
    const captureWork = afterPersist.capturePreviewAfterGeneration.mock.calls[0]?.[0] as
      (() => Promise<unknown>) | undefined;
    expect(typeof captureWork).toBe('function');
    await captureWork?.();
    expect(afterPersist.buildPreviewForProject).toHaveBeenCalledWith(PROJECT, 'ckpt_import_1');
  });

  it('survives the chunk shapes the import composer actually produces', async () => {
    // filesXml is the model's own text, one chunk per section plus the
    // composition, joined — so a forgotten closing tag, a fenced body and a
    // path the composition rewrote are all normal, not corruption.
    await persistImportedSite({
      projectId: PROJECT,
      filesXml:
        '<file path="src/sections/Nav.tsx">\n```tsx\nexport const Nav = () => null\n```\n' +
        '<file path="./src/App.tsx">first</file>\n' +
        '<file path="src/App.tsx">composed</file>',
    });

    expect(storedFiles()).toEqual({
      'src/sections/Nav.tsx': 'export const Nav = () => null',
      'src/App.tsx': 'composed',
    });
  });

  it('drops a traversing or absolute path instead of making it a project file key', async () => {
    await persistImportedSite({
      projectId: PROJECT,
      filesXml:
        '<file path="src/App.tsx">ok</file>' +
        '<file path="../../secret.env">AUTH_SECRET=x</file>' +
        '<file path="/etc/passwd">root</file>',
    });

    expect(Object.keys(storedFiles())).toEqual(['src/App.tsx']);
  });

  it('fails the import instead of storing an empty site, in the import error vocabulary', async () => {
    // Succeeding with nothing parseable is the same blank project the missing
    // writer produced, just reached one step earlier.
    for (const filesXml of ['', 'Here are the files you asked for.', '<file path=""></file>']) {
      await expect(persistImportedSite({ projectId: PROJECT, filesXml })).rejects.toThrow(
        IMPORT_NO_FILES_MESSAGE,
      );
    }
    expect(db.projectUpdate).not.toHaveBeenCalled();
    expect(db.executeRaw).not.toHaveBeenCalled();
    // An import that produced nothing is not an AI provider outage.
    expect(importJobErrorCode(new Error(IMPORT_NO_FILES_MESSAGE))).toBe('import_failed');
  });

  it('replaces rather than merges — an import is not an edit returning only changed files', async () => {
    await persistImportedSite({
      projectId: PROJECT,
      filesXml: '<file path="src/App.tsx">imported</file>',
    });
    // The workspace applies an import with isEdit: false. Nothing is read from
    // the project row here, so no prior site can leak into the stored value.
    expect(written().data.lastCode).toBe('<file path="src/App.tsx">\nimported\n</file>');
  });

  it('sweeps a NEED_IMAGE token fulfilment could not replace out of the stored files', async () => {
    // The import prompt shares BASE_RULES with the streamed path, so the model
    // asks for images with the same token. Fulfilment returning the files
    // untouched (no provider configured) must not let the literal string ship.
    await persistImportedSite({
      projectId: PROJECT,
      userId: OWNER,
      filesXml:
        '<file path="src/sections/Hero.tsx"><img src="NEED_IMAGE: pizzeria hero shot | 16:9" /></file>',
    });

    const stored = storedFiles()['src/sections/Hero.tsx'];
    expect(stored).not.toContain('NEED_IMAGE:');
    expect(stored).toContain('data:image/svg+xml');
  });

  it('stores the fulfilled URL when a provider answers, attributed to the importing user', async () => {
    fulfill.fulfillNeedImages.mockImplementation(
      async ({ files }: { files: Array<{ path: string; content: string }> }) =>
        Object.assign(
          files.map((file) => ({
            path: file.path,
            content: file.content.replace(
              'NEED_IMAGE: pizzeria hero shot | 16:9',
              '/uploads/hero.webp',
            ),
          })),
          { unfulfilled: [] },
        ),
    );

    await persistImportedSite({
      projectId: PROJECT,
      userId: OWNER,
      filesXml:
        '<file path="src/sections/Hero.tsx"><img src="NEED_IMAGE: pizzeria hero shot | 16:9" /></file>',
    });

    expect(fulfill.fulfillNeedImages).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT, userId: OWNER }),
    );
    const stored = storedFiles()['src/sections/Hero.tsx'];
    expect(stored).toContain('/uploads/hero.webp');
    expect(stored).not.toContain('NEED_IMAGE:');
  });

  it('still sweeps when fulfilment itself throws — a provider outage cannot ship the token', async () => {
    fulfill.fulfillNeedImages.mockRejectedValue(new Error('image worker unreachable'));

    await persistImportedSite({
      projectId: PROJECT,
      filesXml:
        '<file path="src/sections/Hero.tsx"><img src="NEED_IMAGE: pizzeria hero shot | 16:9" /></file>',
    });

    const stored = storedFiles()['src/sections/Hero.tsx'];
    expect(stored).not.toContain('NEED_IMAGE:');
    expect(stored).toContain('data:image/svg+xml');
  });
});

describe('POST /api/projects/[id]/import', () => {
  const params = () => ({ params: Promise.resolve({ id: PROJECT }) });

  function importRequest(signal?: AbortSignal) {
    // Wrapping a plain Request is what carries a signal into NextRequest, which
    // is how the handler learns the tab closed.
    return new NextRequest(
      new Request(`http://localhost:3000/api/projects/${PROJECT}/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceUrl: SOURCE_URL }),
        signal,
      }),
    );
  }

  function importResult(filesXml: string): UrlImportResult {
    return {
      filesXml,
      sections: [],
      tokens: {} as UrlImportResult['tokens'],
      assets: [],
      warnings: [],
      usedFallback: false,
      inputTokens: 10,
      sourceUrl: SOURCE_URL,
      mode: 'reimagine',
    };
  }

  // Reading the response body is how these cases await the detached work: the
  // handler closes the writer in its `finally`, after the last database write.

  it('stores the site before the job succeeds, so the checkpoint snapshots real files', async () => {
    // createCheckpointAfterGeneration snapshots Project.lastCode, and the panel
    // only offers the checkpoint once the job is terminal — a succeeded import
    // with an unwritten site is the blank checkpoint this ordering prevents.
    const order: string[] = [];
    db.projectUpdate.mockImplementation(async () => {
      order.push('lastCode');
      return {};
    });
    jobs.succeedJob.mockImplementation(async () => {
      order.push('succeed');
      return {};
    });
    run.runProjectUrlImport.mockResolvedValue(
      importResult('<file path="src/App.tsx">imported</file>'),
    );

    const response = await POST(importRequest(), params());
    const body = await response.text();

    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    expect(order).toEqual(['lastCode', 'succeed']);
    expect(storedFiles()).toEqual({ 'src/App.tsx': 'imported' });
    expect(written().data.phase).toBe('COMPLETE');
    expect(jobs.failJob).not.toHaveBeenCalled();
    // The frame the workspace renders from is still sent; it is no longer the
    // only thing that decides whether the import survives a reload.
    expect(body).toContain('"type":"complete"');
    expect(lock.release).toHaveBeenCalled();
  });

  it('hands the job id to the importer, so Firecrawl steps land on the row', async () => {
    // Behavioural, deliberately. This contract used to be pinned by slicing the
    // route's source text up to the first `}),` — which only terminated the call
    // while it sat inside a `Promise.race`. Removing that race left the assertion
    // reading an empty string, so a test that had nothing to do with the change
    // failed while the behaviour it named was intact.
    run.runProjectUrlImport.mockResolvedValue(
      importResult('<file path="src/App.tsx">imported</file>'),
    );

    await POST(importRequest(), params());

    expect(run.runProjectUrlImport).toHaveBeenCalledTimes(1);
    expect(run.runProjectUrlImport.mock.calls[0]?.[0]).toMatchObject({
      projectId: PROJECT,
      userId: OWNER,
      sourceUrl: SOURCE_URL,
      jobId: JOB_ID,
    });
  });

  it('tells the client the import finished only after the site is stored', async () => {
    // The checkpoint for an import is created by the client's `ready` PATCH, which
    // it cannot send before this frame, and captureFileSnapshot reads
    // Project.lastCode — an empty snapshot throws instead of becoming a
    // checkpoint. So the frame must not be able to overtake the write.
    //
    // Held write, no clock: the frame can only be released by resolving the
    // store, so a handler that skipped it (or sent first) writes 'frame' into
    // `order` before 'lastCode' ever gets there.
    const order: string[] = [];
    const storing = Promise.withResolvers<void>();
    db.projectUpdate.mockImplementation(async () => {
      await storing.promise;
      order.push('lastCode');
      return {};
    });
    run.runProjectUrlImport.mockResolvedValue(
      importResult('<file path="src/App.tsx">imported</file>'),
    );

    const response = await POST(importRequest(), params());
    const reader = response.body!.getReader();
    const framed = reader.read().then((chunk) => {
      order.push('frame');
      return new TextDecoder().decode(chunk.value);
    });

    storing.resolve();
    expect(await framed).toContain('"type":"complete"');
    expect(order).toEqual(['lastCode', 'frame']);
    expect(storedFiles()).toEqual({ 'src/App.tsx': 'imported' });
  });

  it('stores the site when the tab closed mid-import', async () => {
    // Nothing here can cancel Playwright or the model, so the import finishes and
    // the credits are spent whether or not anyone is still reading. Discarding the
    // result then was a paid-for import that left the project blank.
    const importing = Promise.withResolvers<UrlImportResult>();
    run.runProjectUrlImport.mockReturnValue(importing.promise);
    const controller = new AbortController();

    const response = await POST(importRequest(controller.signal), params());
    controller.abort();
    importing.resolve(importResult('<file path="src/App.tsx">imported</file>'));
    const body = await response.text();

    // Proof the disconnect was really observed: no frame is written to a reader
    // that is gone …
    expect(body).toBe('');
    // … and the site is stored and the job succeeded all the same.
    expect(storedFiles()).toEqual({ 'src/App.tsx': 'imported' });
    expect(jobs.succeedJob).toHaveBeenCalledWith(JOB_ID);
    expect(jobs.failJob).not.toHaveBeenCalled();
    expect(lock.release).toHaveBeenCalled();
  });

  it('fails the job instead of succeeding with a blank site', async () => {
    run.runProjectUrlImport.mockResolvedValue(importResult('Here are the files you asked for.'));

    const response = await POST(importRequest(), params());
    const body = await response.text();

    expect(db.projectUpdate).not.toHaveBeenCalled();
    expect(jobs.succeedJob).not.toHaveBeenCalled();
    expect(jobs.failJob).toHaveBeenCalledWith(JOB_ID, {
      errorCode: 'import_failed',
      errorMessage: IMPORT_NO_FILES_MESSAGE,
    });
    expect(body).toContain('"type":"error"');
    expect(lock.release).toHaveBeenCalled();
  });

  it('gives the hold back and stops its renew timer when markJobRunning throws', async () => {
    // markJobRunning throws when its conditional UPDATE writes zero rows, which a
    // rolling deploy causes for real: abandonInstanceJobs('deploying') settles the
    // QUEUED IMPORT row this request just inserted. The detached work's `finally`
    // never runs then, so without this the hold's 60s renew timer would push
    // lockExpiresAt out forever and the project would stay locked for the life of
    // the process.
    jobs.markJobRunning.mockRejectedValue(new Error('Job is not startable'));

    await expect(POST(importRequest(), params())).rejects.toThrow('Job is not startable');

    expect(lock.release).toHaveBeenCalledTimes(1);
    // Nothing was streamed and no import ran, so there is nothing else to close.
    expect(run.runProjectUrlImport).not.toHaveBeenCalled();
    expect(ensureJobSettled).not.toHaveBeenCalled();
  });

  it('leaves re-entry to the hold instead of deciding it here', async () => {
    // acquireLock is re-entrant for the same user (NAV-03): a double-submitted
    // import, or Retry import while this user's generation still holds the project,
    // gets ok: true without owning the hold — and renewing or releasing then breaks
    // the run that does own it. holdProjectLock answers that once, so this route must
    // route every renew and release through it and never touch the raw primitives.
    lock.holdProjectLock.mockResolvedValue({
      ok: true,
      reentered: true,
      release: lock.release,
    });
    run.runProjectUrlImport.mockResolvedValue(
      importResult('<file path="src/App.tsx">imported</file>'),
    );

    const response = await POST(importRequest(), params());
    await response.text();

    expect(lock.holdProjectLock).toHaveBeenCalledWith(PROJECT, OWNER, 'import');
    expect(lock.beginLockHeartbeat).not.toHaveBeenCalled();
    expect(lock.releaseLock).not.toHaveBeenCalled();
    // A re-entered release is a no-op, so calling it unconditionally is correct.
    expect(lock.release).toHaveBeenCalled();
    // The site is still stored — re-entrancy is about the lock, not the work.
    expect(storedFiles()).toEqual({ 'src/App.tsx': 'imported' });
  });
});
