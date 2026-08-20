import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PublishCleanup from '@/lib/publish/cleanup';

/**
 * Deleting a deployment reports what was actually removed.
 *
 * `destroyDeployment` already refuses to delete the row when any provider delete failed,
 * and says so through `failures` / `rowDeleted` — the row is the last thing naming the
 * Coolify uuid and the DNS record id, and the orphan cron only deletes resources this
 * system recorded creating, so throwing the row away makes a running container
 * permanently unreapable. `deleteDeploymentAction` discarded both fields and returned an
 * unconditional success, so the UI settled a success toast and removed the row while the
 * container kept running and billing, the DNS record kept resolving, and the next page
 * load contradicted the toast.
 */

const auth = vi.hoisted(() => ({ getSessionUser: vi.fn() }));
const db = vi.hoisted(() => ({ deploymentFindUnique: vi.fn() }));
const cleanup = vi.hoisted(() => ({ destroyDeployment: vi.fn(), stopDeployment: vi.fn() }));
const audit = vi.hoisted(() => ({ writeAudit: vi.fn() }));

vi.mock('@/lib/auth', () => ({
  getSessionUser: auth.getSessionUser,
  requireAdmin: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
  prisma: { deployment: { findUnique: db.deploymentFindUnique } },
}));
vi.mock('@/lib/publish/cleanup', async (importOriginal) => {
  // The message builder is the real one — the point of the test is that the sentence the
  // user reads names the providers that actually failed.
  const actual = await importOriginal<typeof PublishCleanup>();
  return {
    ...actual,
    destroyDeployment: cleanup.destroyDeployment,
    stopDeployment: cleanup.stopDeployment,
  };
});
vi.mock('@/lib/audit/log', () => ({ writeAudit: audit.writeAudit }));

// Dynamic: `actions.ts` resolves `getSessionUser`, `prisma` and the teardown at module
// scope through its own imports, so it must load after the factories above are registered.
const { deleteDeploymentAction } = await import('@/lib/publish/actions');

const ID = 'dep_1';
const ROW = {
  id: ID,
  slug: 'acme',
  kind: 'LIVE' as const,
  project: { ownerId: 'user_1' },
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.getSessionUser.mockResolvedValue({ id: 'user_1', email: 'o@example.com', role: 'MEMBER' });
  db.deploymentFindUnique.mockResolvedValue(ROW);
  audit.writeAudit.mockResolvedValue(undefined);
  cleanup.destroyDeployment.mockResolvedValue({
    deployment: ROW,
    keptCloudflareZones: [],
    failures: [],
    rowDeleted: true,
  });
});

describe('deleteDeploymentAction', () => {
  it('reports a clean teardown as deleted', async () => {
    await expect(deleteDeploymentAction(ID, 'acme')).resolves.toEqual({
      ok: true,
      data: { id: ID, rowDeleted: true, failures: [], message: 'Deployment deleted.' },
    });
  });

  it('does not claim a deletion when the providers refused', async () => {
    cleanup.destroyDeployment.mockResolvedValue({
      deployment: ROW,
      keptCloudflareZones: [],
      failures: ['coolify', 'dns'],
      rowDeleted: false,
    });

    const result = await deleteDeploymentAction(ID, 'acme');

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ id: ID, rowDeleted: false, failures: ['coolify', 'dns'] });
    // The sentence has to name what survived: the container is still billing and the
    // record is still resolving.
    expect(result.data?.message).toContain('the Coolify application');
    expect(result.data?.message).toContain('the DNS record');
    expect(result.data?.message).not.toContain('the deploy repository');
    expect(result.data?.message).not.toMatch(/deleted/i);
  });

  it('records the failed providers in the audit entry', async () => {
    cleanup.destroyDeployment.mockResolvedValue({
      deployment: ROW,
      keptCloudflareZones: [],
      failures: ['repo'],
      rowDeleted: false,
    });

    await deleteDeploymentAction(ID, 'acme');

    expect(audit.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'deployment.delete',
        after: expect.objectContaining({ failures: ['repo'], rowDeleted: false }),
      }),
    );
  });

  it('says so plainly when the row had already gone', async () => {
    cleanup.destroyDeployment.mockResolvedValue(null);

    const result = await deleteDeploymentAction(ID, 'acme');

    expect(result.data).toMatchObject({ id: ID, rowDeleted: true, failures: [] });
    expect(result.data?.message).toBe('This deployment had already been removed.');
  });

  it('still refuses a wrong confirmation before touching anything', async () => {
    await expect(deleteDeploymentAction(ID, 'acme-typo')).resolves.toEqual({
      ok: false,
      error: 'Type the slug to confirm',
      status: 422,
    });
    expect(cleanup.destroyDeployment).not.toHaveBeenCalled();
  });
});
