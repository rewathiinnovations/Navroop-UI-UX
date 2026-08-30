import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What `setPreviewPasswordAction` is allowed to do inside one request.
 *
 * It used to await the whole publish: `updatePreviewPassword` called `runPublishJob`, which
 * polls Coolify for up to ten minutes. No platform lets a server action live that long, so
 * the user was told "Password update fail" for a publish that was still running — and,
 * unlike both real publish entry points, the action took no project lock at all, so it
 * could interleave with a generation or another publish (F-232).
 *
 * Goes red if the action starts blocking on the build again, if it stops holding the
 * project lock across it, or if it stops giving the lock back.
 */

const auth = vi.hoisted(() => ({ getSessionUser: vi.fn() }));
const db = vi.hoisted(() => ({ projectFindFirst: vi.fn() }));
const publish = vi.hoisted(() => ({
  updatePreviewPassword: vi.fn(),
  getProjectDeployments: vi.fn(),
  startPublishJob: vi.fn(),
}));
const lock = vi.hoisted(() => ({ holdProjectLock: vi.fn(), release: vi.fn() }));

vi.mock('@/lib/auth', () => ({ getSessionUser: auth.getSessionUser, requireAdmin: vi.fn() }));
vi.mock('@/lib/db', () => ({ prisma: { project: { findFirst: db.projectFindFirst } } }));
vi.mock('@/lib/publish/publish', () => ({
  updatePreviewPassword: publish.updatePreviewPassword,
  getProjectDeployments: publish.getProjectDeployments,
  startPublishJob: publish.startPublishJob,
  PublishConflictError: class PublishConflictError extends Error {},
}));
vi.mock('@/lib/publish/execute', () => ({ runPublishJob: vi.fn() }));
vi.mock('@/lib/publish/files', () => ({
  projectHasPublishableFiles: async () => ({ status: 'ready' as const }),
  /** This project builds, so the publish gate has nothing to say about it. */
  siteFailsToBuild: async () => false,
  PUBLISH_FILES_BROKEN: 'broken',
}));
vi.mock('@/lib/publish/slug', () => ({
  resolveUniqueSlug: async () => 'shop',
  urlForSlug: () => 'https://shop.navroop.test',
}));
vi.mock('@/lib/integrations/store', () => ({
  getPublishReadiness: async () => ({ missing: [], unreadable: [] }),
  peekRootDomain: async () => 'navroop.test',
}));
vi.mock('@/lib/domains/store', () => ({ mapPrimaryHosts: async () => new Map() }));
vi.mock('@/lib/jobs', () => ({
  getLatestJobByKind: async () => null,
  toPublicJob: (job: unknown) => job,
}));
vi.mock('@/lib/audit/log', () => ({ writeAudit: vi.fn() }));
vi.mock('@/lib/projects/lock', () => ({ holdProjectLock: lock.holdProjectLock }));

// Dynamic: `actions.ts` resolves the session, prisma and the publish entry points at module
// scope through its own imports, so it must load after the factories above are registered.
const { setPreviewPasswordAction } = await import('@/lib/publish/actions');
const { PublishConflictError } = await import('@/lib/publish/publish');

const PROJECT = 'proj_1';
const USER = { id: 'user_1', role: 'MEMBER', email: 'owner@navroop.test' };

/** A deferred the test resolves by hand, standing in for the ten-minute build. */
function deferred() {
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, settle: settle as () => void };
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.getSessionUser.mockResolvedValue(USER);
  db.projectFindFirst.mockResolvedValue({
    id: PROJECT,
    name: 'Shop',
    ownerId: USER.id,
    lastCode: '{}',
  });
  publish.getProjectDeployments.mockResolvedValue([]);
  lock.release.mockResolvedValue(undefined);
  lock.holdProjectLock.mockResolvedValue({ ok: true, reentered: false, release: lock.release });
  publish.updatePreviewPassword.mockResolvedValue({
    deployment: { id: 'dep_preview' },
    jobId: 'job_1',
    finish: async () => undefined,
  });
});

describe('setPreviewPasswordAction', () => {
  it('returns before the build finishes and gives the lock back when it does', async () => {
    const build = deferred();
    publish.updatePreviewPassword.mockResolvedValue({
      deployment: { id: 'dep_preview' },
      jobId: 'job_1',
      finish: () => build.promise,
    });

    const result = await setPreviewPasswordAction(PROJECT, 'a-preview-passphrase');

    expect(result.ok).toBe(true);
    // The build is still running: the request answered anyway, and the lock is still held.
    expect(lock.release).not.toHaveBeenCalled();

    build.settle();
    await vi.waitFor(() => expect(lock.release).toHaveBeenCalledTimes(1));
  });

  it('holds the project lock for the publish, under the publish reason', async () => {
    await setPreviewPasswordAction(PROJECT, 'a-preview-passphrase');

    expect(lock.holdProjectLock).toHaveBeenCalledWith(PROJECT, USER.id, 'publish');
  });

  it('refuses when another scope holds the lock, without touching the password', async () => {
    lock.holdProjectLock.mockResolvedValue({
      ok: false,
      reason: 'generate',
      heldBy: 'someone-else',
      expiresAt: new Date('2026-08-01T00:05:00.000Z'),
    });

    const result = await setPreviewPasswordAction(PROJECT, 'a-preview-passphrase');

    expect(result.ok).toBe(false);
    expect(publish.updatePreviewPassword).not.toHaveBeenCalled();
  });

  it('gives the lock back when the password write itself fails', async () => {
    publish.updatePreviewPassword.mockRejectedValue(new Error('Publish a preview first'));

    const result = await setPreviewPasswordAction(PROJECT, 'a-preview-passphrase');

    expect(result).toMatchObject({ ok: false, error: 'Publish a preview first', status: 400 });
    expect(lock.release).toHaveBeenCalledTimes(1);
  });

  it('reports a publish of the other kind as a retry-later, not a bad request', async () => {
    publish.updatePreviewPassword.mockRejectedValue(
      new PublishConflictError('A live publish is still running for this project.'),
    );

    const result = await setPreviewPasswordAction(PROJECT, 'a-preview-passphrase');

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(lock.release).toHaveBeenCalledTimes(1);
  });

  it('gives the lock back immediately for a static stack, which needs no build', async () => {
    publish.updatePreviewPassword.mockResolvedValue({
      deployment: { id: 'dep_preview' },
      jobId: null,
      finish: null,
    });

    const result = await setPreviewPasswordAction(PROJECT, 'a-preview-passphrase');

    expect(result.ok).toBe(true);
    expect(lock.release).toHaveBeenCalledTimes(1);
  });

  it('gives the lock back when the background build rejects', async () => {
    publish.updatePreviewPassword.mockResolvedValue({
      deployment: { id: 'dep_preview' },
      jobId: 'job_1',
      finish: async () => {
        throw new Error('Coolify build fail: exited');
      },
    });

    const result = await setPreviewPasswordAction(PROJECT, 'a-preview-passphrase');

    expect(result.ok).toBe(true);
    await vi.waitFor(() => expect(lock.release).toHaveBeenCalledTimes(1));
  });

  it('checks the caller before anything else', async () => {
    auth.getSessionUser.mockResolvedValue(null);

    const result = await setPreviewPasswordAction(PROJECT, 'a-preview-passphrase');

    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(lock.holdProjectLock).not.toHaveBeenCalled();
    expect(publish.updatePreviewPassword).not.toHaveBeenCalled();
  });
});
