import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The F-202 escape hatch. The publish guard refused because the target repository was not
 * created by this project; `confirmRepoOverwrite` is the only way past it, and it must
 * never trust the client's `overwrite: true` alone — the typed name has to equal the
 * deploy repo name derived server-side from the claimed slug. Only then is the existing
 * repo's immutable id adopted onto the Deployment row.
 */

const db = vi.hoisted(() => ({
  deploymentFindUnique: vi.fn(),
  executeRaw: vi.fn(),
}));
const github = vi.hoisted(() => ({
  deployOrg: vi.fn(),
  getDeployRepo: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    deployment: { findUnique: db.deploymentFindUnique },
    $executeRaw: db.executeRaw,
  },
}));
vi.mock('@/lib/github/deploy-client', () => ({
  deployOrg: github.deployOrg,
  getDeployRepo: github.getDeployRepo,
}));

const { confirmRepoOverwrite } = await import('@/lib/publish/overwrite');

const DEPLOYMENT = {
  id: 'dep_1',
  projectId: 'proj_1',
  workspaceId: 'default',
  kind: 'LIVE' as const,
  slug: 'acme',
};

beforeEach(() => {
  vi.clearAllMocks();
  db.deploymentFindUnique.mockResolvedValue(DEPLOYMENT);
  db.executeRaw.mockResolvedValue(1);
  github.deployOrg.mockResolvedValue('deploy-org');
  github.getDeployRepo.mockResolvedValue({
    fullName: 'deploy-org/acme',
    repoId: '424242',
    created: false,
  });
});

describe('confirmRepoOverwrite', () => {
  it('refuses a wrong typed name and adopts nothing', async () => {
    const result = await confirmRepoOverwrite({
      projectId: 'proj_1',
      kind: 'LIVE',
      confirmName: 'acme-typo',
      userId: 'user_1',
    });

    expect(result).toEqual({
      ok: false,
      error: 'Type the repository name "acme" exactly to confirm the replacement.',
      status: 422,
    });
    expect(github.getDeployRepo).not.toHaveBeenCalled();
    expect(db.executeRaw).not.toHaveBeenCalled();
  });

  it('adopts the existing repo id when the typed name matches exactly', async () => {
    const result = await confirmRepoOverwrite({
      projectId: 'proj_1',
      kind: 'LIVE',
      confirmName: 'acme',
      userId: 'user_1',
    });

    expect(result).toEqual({ ok: true });
    expect(github.getDeployRepo).toHaveBeenCalledWith('deploy-org/acme', 'default');
    // The adoption write — what makes the publish guard proceed on the next run.
    expect(db.executeRaw).toHaveBeenCalled();
  });

  it('validates against the PREVIEW repo name for previews', async () => {
    db.deploymentFindUnique.mockResolvedValue({ ...DEPLOYMENT, kind: 'PREVIEW' });
    github.getDeployRepo.mockResolvedValue({
      fullName: 'deploy-org/preview-acme',
      repoId: '9',
      created: false,
    });

    const wrong = await confirmRepoOverwrite({
      projectId: 'proj_1',
      kind: 'PREVIEW',
      confirmName: 'acme',
      userId: 'user_1',
    });
    expect(wrong.ok).toBe(false);

    const right = await confirmRepoOverwrite({
      projectId: 'proj_1',
      kind: 'PREVIEW',
      confirmName: 'preview-acme',
      userId: 'user_1',
    });
    expect(right).toEqual({ ok: true });
  });

  it('succeeds without adopting when the colliding repo is already gone', async () => {
    github.getDeployRepo.mockResolvedValue(null);

    const result = await confirmRepoOverwrite({
      projectId: 'proj_1',
      kind: 'LIVE',
      confirmName: 'acme',
      userId: 'user_1',
    });

    expect(result).toEqual({ ok: true });
    expect(db.executeRaw).not.toHaveBeenCalled();
  });

  it('refuses when there is no deployment or no claimed slug to collide on', async () => {
    db.deploymentFindUnique.mockResolvedValue(null);
    const missing = await confirmRepoOverwrite({
      projectId: 'proj_1',
      kind: 'LIVE',
      confirmName: 'acme',
      userId: 'user_1',
    });
    expect(missing).toMatchObject({ ok: false, status: 404 });

    db.deploymentFindUnique.mockResolvedValue({ ...DEPLOYMENT, slug: 'pending-abc12345' });
    const pending = await confirmRepoOverwrite({
      projectId: 'proj_1',
      kind: 'LIVE',
      confirmName: 'pending-abc12345',
      userId: 'user_1',
    });
    expect(pending).toMatchObject({ ok: false, status: 404 });
    expect(db.executeRaw).not.toHaveBeenCalled();
  });
});
