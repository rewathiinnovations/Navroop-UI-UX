import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Publish reads the newest checkpoint, then the project's stored code. It used
 * to prefer a live sandbox listing; with no sandbox the newest snapshot is the
 * newest site, and the failure modes that matter are "storage could not be
 * read" (must not silently ship a stale site) versus "there is nothing yet".
 */

const db = vi.hoisted(() => ({
  projectFindFirst: vi.fn(),
  checkpointFindFirst: vi.fn(),
}));
const snapshot = vi.hoisted(() => ({
  read: vi.fn(),
  capture: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    project: { findFirst: db.projectFindFirst },
    checkpoint: { findFirst: db.checkpointFindFirst },
  },
}));

class FakeSnapshotReadError extends Error {}

vi.mock('@/lib/checkpoints/snapshot', () => ({
  readSnapshot: snapshot.read,
  captureFileSnapshot: snapshot.capture,
  SnapshotReadError: FakeSnapshotReadError,
}));

const {
  collectPublishFiles,
  projectHasPublishableFiles,
  publishJobErrorCode,
  withoutNeverPublishedPaths,
} = await import('@/lib/publish/files');
const { buildRepoFiles } = await import('@/lib/deploy/repo-files');
const { PublishRepoConflictError } = await import('@/lib/publish/repo-guard');

beforeEach(() => {
  db.projectFindFirst.mockReset();
  db.checkpointFindFirst.mockReset();
  snapshot.read.mockReset();
  snapshot.capture.mockReset();
  db.projectFindFirst.mockResolvedValue({ id: 'p1', stack: 'REACT', lastCode: null });
  db.checkpointFindFirst.mockResolvedValue(null);
  snapshot.read.mockResolvedValue([]);
  snapshot.capture.mockResolvedValue([]);
});

describe('collectPublishFiles', () => {
  it('publishes the newest checkpoint when one exists', async () => {
    db.checkpointFindFirst.mockResolvedValue({ snapshotKey: 'k1', fileSnapshot: null });
    snapshot.read.mockResolvedValue([
      { path: 'src/App.tsx', content: 'export default () => null;' },
      { path: './src/index.css', content: 'body{}' },
    ]);

    await expect(collectPublishFiles('p1')).resolves.toEqual({
      'src/App.tsx': 'export default () => null;',
      'src/index.css': 'body{}',
    });
    expect(snapshot.capture).not.toHaveBeenCalled();
  });

  it('falls back to the stored code when no checkpoint has files', async () => {
    snapshot.capture.mockResolvedValue([{ path: 'index.html', content: '<h1>Hi</h1>' }]);
    await expect(collectPublishFiles('p1')).resolves.toEqual({ 'index.html': '<h1>Hi</h1>' });
  });

  it('refuses rather than publishing nothing', async () => {
    await expect(collectPublishFiles('p1')).rejects.toThrow('no files to publish');
  });

  it('reports a missing project distinctly from an empty one', async () => {
    db.projectFindFirst.mockResolvedValue(null);
    await expect(collectPublishFiles('p1')).rejects.toThrow('Project not found');
  });

  it('propagates a storage failure instead of shipping a stale site', async () => {
    // Falling through to the stored code here would publish an older site
    // under a green publish job.
    db.checkpointFindFirst.mockResolvedValue({ snapshotKey: 'k1', fileSnapshot: null });
    snapshot.read.mockRejectedValue(new FakeSnapshotReadError('S3 down'));
    await expect(collectPublishFiles('p1')).rejects.toBeInstanceOf(FakeSnapshotReadError);
    expect(snapshot.capture).not.toHaveBeenCalled();
  });
});

describe('collectPublishFiles never-publish exclusions', () => {
  // The trees API commits explicit entries, so a .gitignore in the repo is
  // decoration — secrets must be dropped before any file becomes a commit.
  it('excludes secret and vendor paths but keeps .env.example', async () => {
    db.checkpointFindFirst.mockResolvedValue({ snapshotKey: 'k1', fileSnapshot: null });
    snapshot.read.mockResolvedValue([
      { path: 'index.html', content: '<h1>Hi</h1>' },
      { path: '.env', content: 'API_KEY=test-key' },
      { path: '.env.production', content: 'API_KEY=test-key' },
      { path: '.env.example', content: 'API_KEY=' },
      { path: 'config/.env.local', content: 'API_KEY=test-key' },
      { path: 'node_modules/pkg/index.js', content: 'module.exports = 1;' },
      { path: '.git/config', content: '[core]' },
      { path: 'vendor/.git/HEAD', content: 'ref: main' },
      { path: 'certs/server.pem', content: '-----BEGIN-----' },
      { path: '.ssh/id_rsa', content: 'key material' },
      { path: 'id_rsa.pub', content: 'ssh-rsa AAAA' },
    ]);

    await expect(collectPublishFiles('p1')).resolves.toEqual({
      'index.html': '<h1>Hi</h1>',
      '.env.example': 'API_KEY=',
    });
  });

  it('applies the same exclusions to the stored-code fallback', async () => {
    snapshot.capture.mockResolvedValue([
      { path: 'index.html', content: '<h1>Hi</h1>' },
      { path: '.env', content: 'API_KEY=test-key' },
    ]);
    await expect(collectPublishFiles('p1')).resolves.toEqual({ 'index.html': '<h1>Hi</h1>' });
  });

  it('refuses when the checkpoint holds only never-publish files, without falling back', async () => {
    // Falling through to the stored code here would ship a different (stale)
    // site than the checkpoint the user believes they are publishing.
    db.checkpointFindFirst.mockResolvedValue({ snapshotKey: 'k1', fileSnapshot: null });
    snapshot.read.mockResolvedValue([{ path: '.env', content: 'API_KEY=test-key' }]);
    await expect(collectPublishFiles('p1')).rejects.toThrow('no files to publish');
    expect(snapshot.capture).not.toHaveBeenCalled();
  });
});

describe('projectHasPublishableFiles', () => {
  it('is ready when files exist', async () => {
    snapshot.capture.mockResolvedValue([{ path: 'index.html', content: '<h1>Hi</h1>' }]);
    await expect(projectHasPublishableFiles('p1')).resolves.toEqual({ status: 'ready' });
  });

  it('is empty for a project with nothing, or no project at all', async () => {
    await expect(projectHasPublishableFiles('p1')).resolves.toEqual({ status: 'empty' });
    db.projectFindFirst.mockResolvedValue(null);
    await expect(projectHasPublishableFiles('p1')).resolves.toEqual({ status: 'empty' });
  });

  it('is unavailable — not empty — when storage fails', async () => {
    // 'unavailable' is truthy, so a caller that coerces this to a boolean
    // would offer Publish during an outage.
    db.checkpointFindFirst.mockResolvedValue({ snapshotKey: 'k1', fileSnapshot: null });
    snapshot.read.mockRejectedValue(new FakeSnapshotReadError('S3 down'));
    const state = await projectHasPublishableFiles('p1');
    expect(state.status).toBe('unavailable');
  });
});

describe('publishJobErrorCode', () => {
  it('names a storage failure and a repo refusal, and stays generic otherwise', () => {
    expect(publishJobErrorCode(new FakeSnapshotReadError('x'))).toBe('snapshot_unreadable');
    expect(publishJobErrorCode(new PublishRepoConflictError('deploy-org/x'))).toBe('repo_conflict');
    expect(publishJobErrorCode(new Error('boom'))).toBe('provider_error');
  });
});

describe('withoutNeverPublishedPaths', () => {
  // Publish lays the stack scaffold and the host files (Dockerfile, package.json,
  // .gitignore) around the generated files with `buildRepoFiles`, then runs this over the
  // result. It has to drop exactly the same things `toMap` drops — and none of what
  // `buildRepoFiles` adds, or the deploy repo goes back to being unbuildable.
  it('drops secrets and vendor paths from an already-merged file set', () => {
    expect(
      withoutNeverPublishedPaths({
        'app/page.tsx': 'export default () => null;',
        '.env': 'API_KEY=test-key',
        'config/.env.production': 'API_KEY=test-key',
        'node_modules/pkg/index.js': 'module.exports = 1;',
        'certs/server.pem': '-----BEGIN-----',
      }),
    ).toEqual({ 'app/page.tsx': 'export default () => null;' });
  });

  it('keeps every file buildRepoFiles adds', () => {
    const built = buildRepoFiles('NEXTJS', { 'app/page.tsx': 'x' }, { projectName: 'Acme' });
    expect(withoutNeverPublishedPaths(built)).toEqual(built);
    // Named so the two claims above cannot both pass on an empty object.
    expect(Object.keys(built)).toEqual(
      expect.arrayContaining(['package.json', 'Dockerfile', '.gitignore', '.dockerignore']),
    );
  });
});
