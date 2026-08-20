import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma';

/**
 * F-804: `listProjects` wrapped its Prisma query in a bare `catch {}` and re-ran
 * the list as raw SQL. The comment justified the fallback for one cause — a
 * stale Prisma client whose DMMF predates a column — but the catch had no
 * discrimination, so pool exhaustion, a permissions error or a genuine schema
 * break all silently took the fallback and were reported to the user as a
 * successful list. A real outage looked like an empty workspace.
 *
 * Worse, the two paths disagreed on the payload: the publish badge was computed
 * **only on the fallback**, so a project card showed Live/Preview only when the
 * primary query had failed — a rendering difference nobody could reproduce
 * without breaking the database.
 *
 * Both halves are asserted here: a real failure surfaces as a failure, and the
 * two paths return one shape.
 */

const db = vi.hoisted(() => ({
  findMany: vi.fn(),
  deploymentFindMany: vi.fn(),
  queryRawUnsafe: vi.fn(),
}));
const auth = vi.hoisted(() => ({ getSessionUser: vi.fn() }));
const logger = vi.hoisted(() => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  logError: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    project: { findMany: db.findMany },
    deployment: { findMany: db.deploymentFindMany },
    $queryRawUnsafe: db.queryRawUnsafe,
  },
}));
vi.mock('@/lib/auth', () => ({ getSessionUser: auth.getSessionUser }));
vi.mock('@/lib/logger', () => ({ log: logger.log, logError: logger.logError }));

const ROW = {
  id: 'p1',
  name: 'Site',
  thumbnailUrl: null,
  status: 'READY',
  phase: 'COMPLETE' as const,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-02'),
  ownerId: 'u1',
  owner: { name: 'Dell', avatarUrl: null },
  stars: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.getSessionUser.mockResolvedValue({ id: 'u1', role: 'ADMIN', name: 'Dell', email: 'a@b.c' });
  db.deploymentFindMany.mockResolvedValue([]);
});

describe('listProjects error shape', () => {
  it('surfaces a pool/permissions failure instead of reporting an empty list', async () => {
    // Not a stale-client error: a plain connection failure.
    db.findMany.mockRejectedValue(new Error('too many connections for role'));
    const { listProjects } = await import('@/lib/projects/actions');

    const result = await listProjects({});

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('a database outage must not read as a successful list');
    expect(result.status).toBe(500);
    // The fallback must not have been reached — it would have answered `ok`.
    expect(db.queryRawUnsafe).not.toHaveBeenCalled();
    expect(logger.logError).toHaveBeenCalledWith(
      'projects.list_failed',
      expect.anything(),
      expect.objectContaining({ userId: 'u1' }),
    );
  });

  it('does not disguise a failure as zero projects', async () => {
    db.findMany.mockRejectedValue(new Error('permission denied for table Project'));
    const { listProjects } = await import('@/lib/projects/actions');

    const result = await listProjects({});

    // Audit invariant 4: `[]` is not "nothing happened".
    expect(result).not.toMatchObject({ ok: true, data: { projects: [] } });
  });

  it('takes the raw-SQL fallback only for the stale client it exists for', async () => {
    db.findMany.mockRejectedValue(
      new Prisma.PrismaClientValidationError('Unknown field `starred`', {
        clientVersion: 'test',
      }),
    );
    db.queryRawUnsafe.mockResolvedValue([
      {
        id: 'p1',
        name: 'Site',
        thumbnailUrl: null,
        status: 'READY',
        phase: 'COMPLETE',
        createdAt: ROW.createdAt,
        updatedAt: ROW.updatedAt,
        ownerId: 'u1',
        ownerName: 'Dell',
        ownerAvatarUrl: null,
        starred: false,
      },
    ]);
    const { listProjects } = await import('@/lib/projects/actions');

    const result = await listProjects({});

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected the fallback to answer');
    expect(db.queryRawUnsafe).toHaveBeenCalled();
    expect(result.data.projects).toHaveLength(1);
  });

  it('reports a failure when the fallback itself fails', async () => {
    db.findMany.mockRejectedValue(
      new Prisma.PrismaClientValidationError('Unknown field `phase`', { clientVersion: 'test' }),
    );
    db.queryRawUnsafe.mockRejectedValue(new Error('relation "Project" does not exist'));
    const { listProjects } = await import('@/lib/projects/actions');

    const result = await listProjects({});

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure');
    expect(result.status).toBe(500);
  });

  it('gives both paths the same row shape, so the publish badge is not fallback-only', async () => {
    const { listProjects } = await import('@/lib/projects/actions');

    db.findMany.mockResolvedValue([ROW]);
    const healthy = await listProjects({});

    db.findMany.mockRejectedValue(
      new Prisma.PrismaClientValidationError('Unknown field `stars`', { clientVersion: 'test' }),
    );
    db.queryRawUnsafe.mockResolvedValue([
      {
        id: 'p1',
        name: 'Site',
        thumbnailUrl: null,
        status: 'READY',
        phase: 'COMPLETE',
        createdAt: ROW.createdAt,
        updatedAt: ROW.updatedAt,
        ownerId: 'u1',
        ownerName: 'Dell',
        ownerAvatarUrl: null,
        starred: false,
      },
    ]);
    const degraded = await listProjects({});

    if (!healthy.ok || !degraded.ok) throw new Error('expected both paths to answer');
    expect(Object.keys(healthy.data.projects[0]!).sort()).toEqual(
      Object.keys(degraded.data.projects[0]!).sort(),
    );
    // The three fields that used to exist only on the degraded path.
    expect(healthy.data.projects[0]).toHaveProperty('publishBadge');
    expect(healthy.data.projects[0]).toHaveProperty('liveUrl');
    expect(healthy.data.projects[0]).toHaveProperty('previewUrl');
  });

  /**
   * Non-vacuity guard. The fix is one branch — `if (!isStaleClientError(error))`
   * — so this reproduces the bare `catch {}` by making the discriminator answer
   * "stale" for everything, and shows the assertions above genuinely depend on
   * it: the same pool error then takes the fallback and is reported as a
   * successful list, which is exactly F-804.
   */
  it('would report a pool failure as a successful list if the discriminator were indiscriminate', async () => {
    vi.resetModules();
    vi.doMock('@/lib/projects/list-fallback', () => ({ isStaleClientError: () => true }));

    db.findMany.mockRejectedValue(new Error('too many connections for role'));
    db.queryRawUnsafe.mockResolvedValue([]);
    const { listProjects } = await import('@/lib/projects/actions');

    const result = await listProjects({});

    expect(result).toMatchObject({ ok: true, data: { projects: [] } });
    vi.doUnmock('@/lib/projects/list-fallback');
    vi.resetModules();
  });
});
