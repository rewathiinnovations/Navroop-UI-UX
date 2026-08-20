import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What deleting a project is allowed to claim about its live sites.
 *
 * Soft-delete stamps `deletedAt` and then asks Coolify to stop every deployment. That call
 * used to be wrapped in a `catch` that only warned, and the action returned `{ ok: true }`
 * either way — so deleting a published project while Coolify was unreachable removed it
 * from the dashboard while its applications kept serving the deleted site on its live and
 * preview hostnames, kept holding a publish slot and kept billing, with nothing said to the
 * person who pressed the button (F-806).
 *
 * Goes red if a refused stop stops reaching the caller.
 */

const auth = vi.hoisted(() => ({ getSessionUser: vi.fn() }));
const db = vi.hoisted(() => ({ projectFindFirst: vi.fn(), projectUpdate: vi.fn() }));
const cleanup = vi.hoisted(() => ({ stopProjectDeployments: vi.fn() }));
const audit = vi.hoisted(() => ({ writeAudit: vi.fn() }));
const logger = vi.hoisted(() => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  logError: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ getSessionUser: auth.getSessionUser }));
vi.mock('@/lib/db', () => ({
  prisma: { project: { findFirst: db.projectFindFirst, update: db.projectUpdate } },
}));
vi.mock('@/lib/publish/cleanup', () => ({
  stopProjectDeployments: cleanup.stopProjectDeployments,
  partialTeardownMessage: (failures: string[]) => `Could not remove ${failures.join(', ')}.`,
  stoppedPartiallyMessage: (failed: Array<{ deploymentId: string }>) =>
    `${failed.length} deployment is still running.`,
}));
vi.mock('@/lib/audit/log', () => ({ writeAudit: audit.writeAudit }));
vi.mock('@/lib/logger', () => ({ log: logger.log, logError: logger.logError }));

// Dynamic: `projects/actions.ts` resolves the session, prisma and the audit log at module
// scope through its own imports, so it must load after the factories above are registered.
const { deleteProject } = await import('@/lib/projects/actions');

/** `warning` is optional on the success shape, so read it through a narrowing helper. */
function warningOf(result: object): string | null {
  if ('warning' in result && typeof result.warning === 'string') return result.warning;
  return null;
}

const PROJECT = 'proj_1';
const USER = { id: 'user_1', role: 'MEMBER', email: 'owner@navroop.test' };

beforeEach(() => {
  vi.clearAllMocks();
  auth.getSessionUser.mockResolvedValue(USER);
  db.projectFindFirst.mockResolvedValue({ ownerId: USER.id });
  db.projectUpdate.mockResolvedValue({ id: PROJECT, name: 'Shop', deletedAt: new Date() });
  cleanup.stopProjectDeployments.mockResolvedValue({ stopped: 2, failed: [] });
  audit.writeAudit.mockResolvedValue(undefined);
});

describe('deleteProject', () => {
  it('reports a clean delete with no warning', async () => {
    const result = await deleteProject(PROJECT);

    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('warning');
  });

  it('tells the caller when a deployment refused to stop', async () => {
    cleanup.stopProjectDeployments.mockResolvedValue({
      stopped: 0,
      failed: [{ deploymentId: 'dep_live', reason: 'connect ECONNREFUSED' }],
    });

    const result = await deleteProject(PROJECT);

    // The project is gone from the dashboard either way — the row is already stamped and
    // the retention purge is the retry — so this is a warning on a success, not a failure.
    expect(result.ok).toBe(true);
    expect(result).toHaveProperty('warning');
    expect(warningOf(result)).toMatch(/still running/i);
  });

  it('tells the caller when the teardown could not be attempted at all', async () => {
    cleanup.stopProjectDeployments.mockRejectedValue(new Error('Coolify integration removed'));

    const result = await deleteProject(PROJECT);

    expect(result.ok).toBe(true);
    expect(warningOf(result)).toBeTruthy();
    expect(logger.logError).toHaveBeenCalledWith(
      'projects.soft_delete_stop_failed',
      expect.any(Error),
      expect.objectContaining({ projectId: PROJECT }),
    );
  });

  it('checks the caller before stamping anything', async () => {
    auth.getSessionUser.mockResolvedValue(null);

    const result = await deleteProject(PROJECT);

    expect(result.ok).toBe(false);
    expect(db.projectUpdate).not.toHaveBeenCalled();
  });

  it('refuses a project the caller does not own', async () => {
    db.projectFindFirst.mockResolvedValue({ ownerId: 'someone-else' });

    const result = await deleteProject(PROJECT);

    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(db.projectUpdate).not.toHaveBeenCalled();
    expect(cleanup.stopProjectDeployments).not.toHaveBeenCalled();
  });
});
