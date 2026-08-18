import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SnapshotReadError } from '@/lib/checkpoints/snapshot';

/**
 * Publish file collection after storage started telling the truth.
 *
 * `readSnapshot` now throws `SnapshotReadError` when the object store fails. These
 * cases pin the three publish-side answers that used to treat that failure as
 * "nothing here": fall through to stale `lastCode` and ship it, tell the UI the
 * project is ready to publish, or swallow a sandbox read and try the checkpoint
 * without a log. A READY sandbox that cannot be listed or read is also a
 * failure — not a cue to ship the last snapshot. A storage outage plus any of
 * those is how a stale site goes live under a green job, or how Publish is
 * offered and then the job fails.
 *
 * Prisma, the snapshot store and the sandbox driver are stubbed. Nothing here
 * opens a socket or writes the repo.
 *
 * Goes red if: `collectPublishFiles` catches `readSnapshot` and reaches
 * `captureFileSnapshot`; `projectHasPublishableFiles` answers ready from
 * `lastCode` after a snapshot read failure; a sandbox list/reconnect failure
 * returns `{}` without a log; a READY list+read success ships the checkpoint
 * instead of the live files; a missing project is treated as ready; or an
 * unexpected collect error is swallowed into empty/unavailable.
 */

const db = vi.hoisted(() => ({
  projectFindFirst: vi.fn(),
  checkpointFindFirst: vi.fn(),
}));

const snapshot = vi.hoisted(() => ({
  readSnapshot: vi.fn(),
  captureFileSnapshot: vi.fn(),
}));

const sandbox = vi.hoisted(() => ({
  getLiveProvider: vi.fn(),
  create: vi.fn(),
}));

const logger = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    project: { findFirst: (...args: unknown[]) => db.projectFindFirst(...args) },
    checkpoint: { findFirst: (...args: unknown[]) => db.checkpointFindFirst(...args) },
  },
}));

vi.mock('@/lib/checkpoints/snapshot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/checkpoints/snapshot')>();
  return {
    ...actual,
    readSnapshot: (...args: unknown[]) => snapshot.readSnapshot(...args),
    captureFileSnapshot: (...args: unknown[]) => snapshot.captureFileSnapshot(...args),
  };
});

vi.mock('@/lib/sandbox/manager', () => ({
  getLiveProvider: (...args: unknown[]) => sandbox.getLiveProvider(...args),
}));

vi.mock('@/lib/sandbox/factory', () => ({
  SandboxFactory: { create: (...args: unknown[]) => sandbox.create(...args) },
}));

vi.mock('@/lib/logger', () => ({
  log: {
    warn: (...args: unknown[]) => logger.warn(...args),
    error: (...args: unknown[]) => logger.error(...args),
    info: (...args: unknown[]) => logger.info(...args),
    debug: (...args: unknown[]) => logger.debug(...args),
  },
}));

const {
  collectPublishFiles,
  projectHasPublishableFiles,
  publishJobErrorCode,
  PUBLISH_FILES_UNAVAILABLE,
  PublishLiveFilesError,
} = await import('@/lib/publish/files.ts');

const PROJECT = 'proj_publish_files_storage';
const SNAPSHOT_KEY = 'snapshots/proj_publish_files_storage/cp_latest.json.gz';
const STALE_LAST_CODE = 'export default function App(){return <h1>Yesterday</h1>}';

function snapshotReadFailure() {
  return new SnapshotReadError(SNAPSHOT_KEY, new Error('Access Denied'));
}

function draftProject(overrides: Record<string, unknown> = {}) {
  return {
    id: PROJECT,
    sandboxId: null,
    sandboxStatus: 'NONE',
    stack: 'NEXTJS',
    lastCode: STALE_LAST_CODE,
    ...overrides,
  };
}

beforeEach(() => {
  db.projectFindFirst.mockReset();
  db.checkpointFindFirst.mockReset();
  snapshot.readSnapshot.mockReset();
  snapshot.captureFileSnapshot.mockReset();
  sandbox.getLiveProvider.mockReset();
  sandbox.create.mockReset();
  logger.warn.mockReset();
  db.projectFindFirst.mockResolvedValue(draftProject());
  db.checkpointFindFirst.mockResolvedValue({
    snapshotKey: SNAPSHOT_KEY,
    fileSnapshot: null,
  });
  snapshot.captureFileSnapshot.mockResolvedValue([
    { path: 'src/App.jsx', content: STALE_LAST_CODE },
  ]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('collectPublishFiles — storage failure must not reach lastCode', () => {
  it('propagates SnapshotReadError and never calls captureFileSnapshot', async () => {
    snapshot.readSnapshot.mockRejectedValue(snapshotReadFailure());

    await expect(collectPublishFiles(PROJECT)).rejects.toBeInstanceOf(SnapshotReadError);
    expect(snapshot.captureFileSnapshot).not.toHaveBeenCalled();
  });

  it('still uses lastCode when the checkpoint is genuinely empty', async () => {
    snapshot.readSnapshot.mockResolvedValue([]);

    const files = await collectPublishFiles(PROJECT);

    expect(snapshot.captureFileSnapshot).toHaveBeenCalledWith(PROJECT);
    expect(files['src/App.jsx']).toBe(STALE_LAST_CODE);
  });
});

describe('projectHasPublishableFiles — do not offer Publish from stale lastCode', () => {
  it('returns unavailable when the snapshot cannot be read, even if lastCode is set', async () => {
    snapshot.readSnapshot.mockRejectedValue(snapshotReadFailure());

    const result = await projectHasPublishableFiles(PROJECT);

    expect(result).toEqual({ status: 'unavailable', reason: PUBLISH_FILES_UNAVAILABLE });
    expect(PUBLISH_FILES_UNAVAILABLE.toLowerCase()).toContain('storage');
    expect(PUBLISH_FILES_UNAVAILABLE.toLowerCase()).not.toContain('no files');
    expect(typeof result).not.toBe('boolean');
    expect(result).not.toBe(true);
    expect(snapshot.captureFileSnapshot).not.toHaveBeenCalled();
  });

  it('returns empty when collect honestly finds no files', async () => {
    db.projectFindFirst.mockResolvedValue(draftProject({ lastCode: null }));
    snapshot.readSnapshot.mockResolvedValue([]);
    snapshot.captureFileSnapshot.mockResolvedValue([]);

    await expect(projectHasPublishableFiles(PROJECT)).resolves.toEqual({ status: 'empty' });
  });

  it('returns ready when collect finds checkpoint files', async () => {
    snapshot.readSnapshot.mockResolvedValue([
      { path: 'app/page.tsx', content: 'export default function Page(){return null}' },
    ]);

    await expect(projectHasPublishableFiles(PROJECT)).resolves.toEqual({ status: 'ready' });
  });
});

describe('filesFromReadySandbox — live listing and reads must not invent a tree', () => {
  function readyProject() {
    return draftProject({ sandboxId: 'sbx_live', sandboxStatus: 'READY' });
  }

  it('does not silently drop an unreadable publishable file', async () => {
    db.projectFindFirst.mockResolvedValue(readyProject());
    const readFile = vi.fn(async (path: string) => {
      if (path === 'app/page.tsx') throw new Error('ENOENT: no such file');
      return 'export default function Layout(){return null}';
    });
    sandbox.getLiveProvider.mockReturnValue({
      listFiles: vi.fn().mockResolvedValue(['app/page.tsx', 'app/layout.tsx']),
      readFile,
    });
    snapshot.readSnapshot.mockResolvedValue([
      { path: 'app/page.tsx', content: 'export default function Page(){return <h1>Stale</h1>}' },
    ]);

    const failed = await collectPublishFiles(PROJECT).then(
      (files) => files,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(PublishLiveFilesError);
    expect(String(failed)).toMatch(/app\/page\.tsx/);
    expect(String(failed)).toMatch(/incomplete site/i);
    expect(String(failed)).toMatch(/ENOENT: no such file/);
    expect(String(failed).toLowerCase()).not.toMatch(/build (failed|did not)/);
    expect(failed).toMatchObject({ code: 'sandbox_file_unreadable' });
    expect(snapshot.readSnapshot).not.toHaveBeenCalled();
    expect(snapshot.captureFileSnapshot).not.toHaveBeenCalled();
  });

  it('does not fall through to a checkpoint when listing a READY sandbox fails', async () => {
    db.projectFindFirst.mockResolvedValue(readyProject());
    sandbox.getLiveProvider.mockReturnValue({
      listFiles: vi.fn().mockRejectedValue(new Error('sandbox list timed out')),
      readFile: vi.fn(),
    });
    snapshot.readSnapshot.mockResolvedValue([
      { path: 'app/page.tsx', content: 'export default function Page(){return null}' },
    ]);

    const failed = await collectPublishFiles(PROJECT).then(
      (files) => files,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(PublishLiveFilesError);
    expect(failed).toMatchObject({ code: 'sandbox_list_failed' });
    expect(String(failed)).toMatch(/sandbox list timed out/);
    expect(String(failed)).toMatch(/older snapshot/i);
    expect(String(failed).toLowerCase()).not.toMatch(/build (failed|did not)/);
    expect(snapshot.readSnapshot).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'publish.sandbox_list_failed',
      expect.objectContaining({
        projectId: PROJECT,
        sandboxId: 'sbx_live',
        error: 'sandbox list timed out',
      }),
    );
  });

  it('does not fall through to a checkpoint when reconnect cannot tell if the sandbox is alive', async () => {
    db.projectFindFirst.mockResolvedValue(readyProject());
    sandbox.getLiveProvider.mockReturnValue(null);
    sandbox.create.mockReturnValue({
      reconnect: vi.fn().mockRejectedValue(new Error('Daytona API timed out')),
    });
    snapshot.readSnapshot.mockResolvedValue([
      { path: 'app/page.tsx', content: 'export default function Page(){return null}' },
    ]);

    const failed = await collectPublishFiles(PROJECT).then(
      (files) => files,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(PublishLiveFilesError);
    expect(failed).toMatchObject({ code: 'sandbox_status_unknown' });
    expect(String(failed)).toMatch(/Daytona API timed out/);
    expect(String(failed)).toMatch(/could not tell/i);
    expect(snapshot.readSnapshot).not.toHaveBeenCalled();
  });

  it('still uses the checkpoint when there is no live sandbox', async () => {
    db.projectFindFirst.mockResolvedValue(draftProject({ sandboxId: null, sandboxStatus: 'NONE' }));
    snapshot.readSnapshot.mockResolvedValue([
      { path: 'app/page.tsx', content: 'export default function Page(){return null}' },
    ]);

    const files = await collectPublishFiles(PROJECT);

    expect(files['app/page.tsx']).toContain('Page');
    expect(sandbox.getLiveProvider).not.toHaveBeenCalled();
  });

  it('still uses the checkpoint when reconnect reports the sandbox is gone', async () => {
    db.projectFindFirst.mockResolvedValue(readyProject());
    sandbox.getLiveProvider.mockReturnValue(null);
    sandbox.create.mockReturnValue({
      reconnect: vi.fn().mockResolvedValue(false),
    });
    snapshot.readSnapshot.mockResolvedValue([
      { path: 'app/page.tsx', content: 'export default function Page(){return null}' },
    ]);

    const files = await collectPublishFiles(PROJECT);

    expect(files['app/page.tsx']).toContain('Page');
    expect(snapshot.readSnapshot).toHaveBeenCalled();
  });

  it('does not reach lastCode when a READY listing fails', async () => {
    db.projectFindFirst.mockResolvedValue(readyProject());
    sandbox.getLiveProvider.mockReturnValue({
      listFiles: vi.fn().mockRejectedValue(new Error('sandbox list timed out')),
      readFile: vi.fn(),
    });
    snapshot.readSnapshot.mockRejectedValue(snapshotReadFailure());

    await expect(collectPublishFiles(PROJECT)).rejects.toBeInstanceOf(PublishLiveFilesError);
    expect(snapshot.readSnapshot).not.toHaveBeenCalled();
    expect(snapshot.captureFileSnapshot).not.toHaveBeenCalled();
  });

  it('returns unavailable (not empty) when a live file cannot be read', async () => {
    db.projectFindFirst.mockResolvedValue(readyProject());
    sandbox.getLiveProvider.mockReturnValue({
      listFiles: vi.fn().mockResolvedValue(['app/page.tsx']),
      readFile: vi.fn().mockRejectedValue(new Error('EACCES')),
    });

    const result = await projectHasPublishableFiles(PROJECT);
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reason).toMatch(/app\/page\.tsx/);
      expect(result.reason).toMatch(/incomplete site/i);
    }
  });

  it('returns the files the live sandbox listed and read, not the checkpoint', async () => {
    db.projectFindFirst.mockResolvedValue(readyProject());
    const contents: Record<string, string> = {
      'app/page.tsx': 'export default function Page(){return <h1>Live</h1>}',
      'app/layout.tsx': 'export default function Layout({children}){return children}',
      'package.json': '{"name":"live-site"}',
      'README.md': '# Live',
      'public/logo.svg': '<svg />',
      'notes.txt': 'ship this',
      'lib/util.mjs': 'export const n = 1',
      'lib/util.cjs': 'module.exports = {}',
      'next.config.js': 'module.exports = {}',
      'app/globals.css': 'body{margin:0}',
    };
    const skipped = [
      'node_modules/react/index.js',
      '.next/server/app/page.js',
      'dist/bundle.js',
      'build/out.js',
      '.git/config',
      '.vercel/project.json',
      'public/hero.png',
      'app/secret.wasm',
      'LICENSE',
    ];
    const readFile = vi.fn(async (path: string) => {
      if (!(path in contents)) throw new Error(`unexpected read of ${path}`);
      return contents[path];
    });
    sandbox.getLiveProvider.mockReturnValue({
      listFiles: vi.fn().mockResolvedValue(['./app/page.tsx', ...Object.keys(contents).slice(1), ...skipped]),
      readFile,
    });
    snapshot.readSnapshot.mockResolvedValue([
      { path: 'app/page.tsx', content: 'export default function Page(){return <h1>Stale</h1>}' },
    ]);

    const files = await collectPublishFiles(PROJECT);

    expect(files).toEqual(contents);
    expect(files['app/page.tsx']).toContain('Live');
    expect(files['app/page.tsx']).not.toContain('Stale');
    expect(Object.keys(files).sort()).toEqual(Object.keys(contents).sort());
    expect(readFile.mock.calls.map(([path]) => path).sort()).toEqual(Object.keys(contents).sort());
    expect(snapshot.readSnapshot).not.toHaveBeenCalled();
    expect(snapshot.captureFileSnapshot).not.toHaveBeenCalled();
  });

  it('uses a reconnected provider when the in-process handle is gone', async () => {
    db.projectFindFirst.mockResolvedValue(readyProject());
    const readFile = vi.fn().mockResolvedValue('export default function Page(){return <h1>Reconnected</h1>}');
    const reconnect = vi.fn().mockResolvedValue(true);
    sandbox.getLiveProvider.mockReturnValue(null);
    sandbox.create.mockReturnValue({
      reconnect,
      listFiles: vi.fn().mockResolvedValue(['app/page.tsx']),
      readFile,
    });
    snapshot.readSnapshot.mockResolvedValue([
      { path: 'app/page.tsx', content: 'export default function Page(){return <h1>Stale</h1>}' },
    ]);

    const files = await collectPublishFiles(PROJECT);

    expect(reconnect).toHaveBeenCalledWith('sbx_live', 3_000);
    expect(files['app/page.tsx']).toContain('Reconnected');
    expect(files['app/page.tsx']).not.toContain('Stale');
    expect(snapshot.readSnapshot).not.toHaveBeenCalled();
  });

  it('falls through to the checkpoint when the live tree has no publishable files', async () => {
    db.projectFindFirst.mockResolvedValue(readyProject());
    const readFile = vi.fn();
    sandbox.getLiveProvider.mockReturnValue({
      listFiles: vi.fn().mockResolvedValue(['node_modules/react/index.js', 'public/hero.png', 'LICENSE']),
      readFile,
    });
    snapshot.readSnapshot.mockResolvedValue([
      { path: 'app/page.tsx', content: 'export default function Page(){return <h1>Checkpoint</h1>}' },
    ]);

    const files = await collectPublishFiles(PROJECT);

    expect(readFile).not.toHaveBeenCalled();
    expect(files['app/page.tsx']).toContain('Checkpoint');
    expect(snapshot.readSnapshot).toHaveBeenCalled();
  });

  it('rethrows a typed list failure without wrapping it again', async () => {
    db.projectFindFirst.mockResolvedValue(readyProject());
    sandbox.getLiveProvider.mockReturnValue({
      listFiles: vi.fn().mockRejectedValue(
        new PublishLiveFilesError('sandbox_list_failed', 'already typed from the driver'),
      ),
      readFile: vi.fn(),
    });

    await expect(collectPublishFiles(PROJECT)).rejects.toMatchObject({
      name: 'PublishLiveFilesError',
      code: 'sandbox_list_failed',
      message: 'already typed from the driver',
    });
  });

  it('names a non-Error list failure in the live-files error', async () => {
    db.projectFindFirst.mockResolvedValue(readyProject());
    sandbox.getLiveProvider.mockReturnValue({
      listFiles: vi.fn().mockRejectedValue('provider exploded'),
      readFile: vi.fn(),
    });

    const failed = await collectPublishFiles(PROJECT).then(
      (files) => files,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(PublishLiveFilesError);
    expect(failed).toMatchObject({ code: 'sandbox_list_failed' });
    expect(String(failed)).toMatch(/provider exploded/);
  });

  it('names a non-Error read failure in the live-files error', async () => {
    db.projectFindFirst.mockResolvedValue(readyProject());
    sandbox.getLiveProvider.mockReturnValue({
      listFiles: vi.fn().mockResolvedValue(['app/page.tsx']),
      readFile: vi.fn().mockRejectedValue('EIO'),
    });

    const failed = await collectPublishFiles(PROJECT).then(
      (files) => files,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(PublishLiveFilesError);
    expect(failed).toMatchObject({ code: 'sandbox_file_unreadable' });
    expect(String(failed)).toMatch(/EIO/);
    expect(String(failed)).toMatch(/app\/page\.tsx/);
  });

  it('names a non-Error reconnect failure without falling through', async () => {
    db.projectFindFirst.mockResolvedValue(readyProject());
    sandbox.getLiveProvider.mockReturnValue(null);
    sandbox.create.mockReturnValue({
      reconnect: vi.fn().mockRejectedValue('Daytona hung'),
    });

    const failed = await collectPublishFiles(PROJECT).then(
      (files) => files,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(PublishLiveFilesError);
    expect(failed).toMatchObject({ code: 'sandbox_status_unknown' });
    expect(String(failed)).toMatch(/Daytona hung/);
    expect(snapshot.readSnapshot).not.toHaveBeenCalled();
  });
});

describe('collectPublishFiles — missing project and checkpoint mapping', () => {
  it('throws when the project row is missing', async () => {
    db.projectFindFirst.mockResolvedValue(null);

    await expect(collectPublishFiles(PROJECT)).rejects.toThrow('Project not found');
    expect(snapshot.readSnapshot).not.toHaveBeenCalled();
  });

  it('uses lastCode when there is no checkpoint row', async () => {
    db.checkpointFindFirst.mockResolvedValue(null);

    const files = await collectPublishFiles(PROJECT);

    expect(snapshot.readSnapshot).not.toHaveBeenCalled();
    expect(snapshot.captureFileSnapshot).toHaveBeenCalledWith(PROJECT);
    expect(files['src/App.jsx']).toBe(STALE_LAST_CODE);
  });

  it('drops empty and .git paths when mapping a checkpoint', async () => {
    snapshot.readSnapshot.mockResolvedValue([
      { path: './app/page.tsx', content: 'export default function Page(){return <h1>Mapped</h1>}' },
      { path: '', content: 'should-not-publish-empty' },
      { path: '/', content: 'should-not-publish-root' },
      { path: '.git/config', content: 'should-not-publish-git' },
      { path: './.git/HEAD', content: 'should-not-publish-git-head' },
    ]);

    const files = await collectPublishFiles(PROJECT);

    expect(files).toEqual({
      'app/page.tsx': 'export default function Page(){return <h1>Mapped</h1>}',
    });
    expect('' in files).toBe(false);
    expect(Object.values(files).join('')).not.toMatch(/should-not-publish/);
  });
});

describe('projectHasPublishableFiles — missing project, filters, unknown errors', () => {
  it('returns empty when the project does not exist', async () => {
    db.projectFindFirst.mockResolvedValue(null);

    await expect(projectHasPublishableFiles(PROJECT)).resolves.toEqual({ status: 'empty' });
  });

  it('rethrows unexpected collect failures instead of offering Publish', async () => {
    snapshot.readSnapshot.mockRejectedValue(new Error('disk on fire'));

    await expect(projectHasPublishableFiles(PROJECT)).rejects.toThrow('disk on fire');
  });
});

describe('publishJobErrorCode — live-file failures are not the AI provider', () => {
  it('maps typed live-file errors to their job codes, not provider_error', () => {
    expect(publishJobErrorCode(new SnapshotReadError(SNAPSHOT_KEY, new Error('Access Denied')))).toBe(
      'snapshot_unreadable',
    );
    expect(
      publishJobErrorCode(
        new PublishLiveFilesError('sandbox_list_failed', 'We could not list the files in the live workspace'),
      ),
    ).toBe('sandbox_list_failed');
    expect(
      publishJobErrorCode(
        new PublishLiveFilesError('sandbox_file_unreadable', 'We could not read app/page.tsx'),
      ),
    ).toBe('sandbox_file_unreadable');
    expect(
      publishJobErrorCode(
        new PublishLiveFilesError('sandbox_status_unknown', 'We could not tell whether the workspace is running'),
      ),
    ).toBe('sandbox_status_unknown');
    expect(publishJobErrorCode(new Error('Coolify build fail'))).toBe('provider_error');
  });
});

describe('publish actions — unavailable is not coerced to a boolean', () => {
  it('getPublishState and startPublish switch on status', () => {
    const source = readFileSync(fileURLToPath(new URL('../../lib/publish/actions.ts', import.meta.url)), 'utf8');
    expect(source).toContain("filesState.status === 'unavailable'");
    expect(source).toContain("filesState.status === 'ready'");
    expect(source).toContain("filesState.status !== 'ready'");
    expect(source).toContain('status: 503');
    expect(source).not.toMatch(/!\s*\(\s*await\s+projectHasPublishableFiles/);
    expect(source).not.toMatch(/Boolean\(\s*await\s+projectHasPublishableFiles/);
    expect(source).not.toMatch(/canPublish\s*=\s*hasFiles\s*&&/);
  });

  it('runPublishJob maps live-file errors via publishJobErrorCode, not provider_error', () => {
    const source = readFileSync(fileURLToPath(new URL('../../lib/publish/execute.ts', import.meta.url)), 'utf8');
    expect(source).toContain('publishJobErrorCode');
    expect(source).not.toMatch(
      /error instanceof SnapshotReadError \? 'snapshot_unreadable' : 'provider_error'/,
    );
  });
});
