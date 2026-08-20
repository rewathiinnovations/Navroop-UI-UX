import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PublishCleanup from '@/lib/publish/cleanup';

/**
 * What the Stop button is allowed to claim.
 *
 * `stopDeployment` detached the custom domains and then called `stopApplication`
 * unguarded, so a Coolify error propagated out of the server action before `STOPPED` was
 * written: the hostnames were already off the application, the row still said LIVE, the
 * site was still running, and the user got a bare 500. `stopProjectDeployments` — the
 * same operation for a soft-deleted project — swallowed the identical error and wrote
 * STOPPED over a container that was still up. Two code paths for one concept, disagreeing
 * about whether a provider failure is fatal (F-223).
 *
 * Goes red if the action starts reporting success for a stop the provider refused, or if
 * a refusal stops naming what is still running.
 */

const auth = vi.hoisted(() => ({ getSessionUser: vi.fn() }));
const db = vi.hoisted(() => ({ deploymentFindUnique: vi.fn() }));
const cleanup = vi.hoisted(() => ({ stopDeployment: vi.fn() }));
const audit = vi.hoisted(() => ({ writeAudit: vi.fn() }));

vi.mock('@/lib/auth', () => ({ getSessionUser: auth.getSessionUser, requireAdmin: vi.fn() }));
vi.mock('@/lib/db', () => ({
  prisma: { deployment: { findUnique: db.deploymentFindUnique } },
}));
vi.mock('@/lib/publish/cleanup', async (importOriginal) => {
  const actual = await importOriginal<typeof PublishCleanup>();
  return { ...actual, stopDeployment: cleanup.stopDeployment };
});
vi.mock('@/lib/audit/log', () => ({ writeAudit: audit.writeAudit }));
vi.mock('@/lib/integrations/store', () => ({
  peekRootDomain: vi.fn(async () => 'navroop.test'),
  getRootDomain: vi.fn(async () => 'navroop.test'),
  getPublishReadiness: vi.fn(async () => ({ missing: [], unreadable: [] })),
}));
vi.mock('@/lib/domains/store', () => ({ mapPrimaryHosts: vi.fn(async () => new Map()) }));

// Dynamic: `actions.ts` resolves `getSessionUser`, `prisma` and the teardown at module
// scope through its own imports, so it must load after the factories above are registered.
const { stopDeploymentAction } = await import('@/lib/publish/actions');

const ID = 'dep_1';
const ROW = {
  id: ID,
  projectId: 'proj_1',
  workspaceId: 'default',
  serverId: 'srv_1',
  kind: 'LIVE' as const,
  status: 'LIVE' as const,
  slug: 'acme',
  url: null,
  progressStep: null,
  lastError: null,
  lastRequestId: null,
  buildLogUrl: null,
  passwordHash: null,
  publishedAt: null,
  createdAt: new Date('2026-08-20T00:00:00.000Z'),
  updatedAt: new Date('2026-08-20T00:00:00.000Z'),
  project: { ownerId: 'user_1' },
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.getSessionUser.mockResolvedValue({ id: 'user_1', email: 'o@example.com', role: 'MEMBER' });
  db.deploymentFindUnique.mockResolvedValue(ROW);
  audit.writeAudit.mockResolvedValue(undefined);
  cleanup.stopDeployment.mockResolvedValue({
    stopped: true,
    deployment: { ...ROW, status: 'STOPPED' },
  });
});

describe('stopDeploymentAction', () => {
  it('returns the stopped deployment and audits it', async () => {
    const result = await stopDeploymentAction(ID);

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ id: ID, status: 'STOPPED' });
    expect(audit.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'deployment.stop', targetId: ID }),
    );
  });

  it('refuses to report a stop Coolify would not perform', async () => {
    cleanup.stopDeployment.mockResolvedValue({
      stopped: false,
      reason: 'Coolify 502 /api/v1/applications/x/stop',
    });

    const result = await stopDeploymentAction(ID);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(502);
    // The sentence has to name what survived: the site is up and the customer's
    // hostnames still point at it.
    expect(result.error).toContain('still running');
    expect(result.error).toContain('custom domains are still attached');
    expect(result.error).toContain('Coolify 502 /api/v1/applications/x/stop');
    // Nothing happened, so nothing is recorded as having happened.
    expect(audit.writeAudit).not.toHaveBeenCalled();
  });

  it('still refuses a caller who does not own the deployment', async () => {
    auth.getSessionUser.mockResolvedValue({
      id: 'user_2',
      email: 'x@example.com',
      role: 'MEMBER',
    });

    await expect(stopDeploymentAction(ID)).resolves.toEqual({
      ok: false,
      error: 'Forbidden',
      status: 403,
    });
    expect(cleanup.stopDeployment).not.toHaveBeenCalled();
  });
});
