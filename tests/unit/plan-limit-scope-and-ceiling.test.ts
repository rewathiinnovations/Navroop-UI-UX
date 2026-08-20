import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_TRACKABLE_STORAGE_BYTES } from '@/lib/storage/usage';

/**
 * Two properties of `lib/plans/limits.ts` that were previously invisible:
 *
 * - F-315 `Workspace.storageBytes` is a Postgres `INTEGER` (~2.0 GiB) while
 *   `Plan.storageBytesLimit` is a `BigInt`. The seeded Pro plan sets 20 GiB, so
 *   `checkLimit('storage')` compared a counter that cannot hold 20 GiB against
 *   20 GiB: the increment errored with "integer out of range" long before the
 *   limit was reached, i.e. the limit could never be enforced on the plans that
 *   need it. The comparison now happens in `BigInt` and clamps to the ceiling the
 *   column can actually represent.
 * - F-320 `projects` and `members` are counted across the whole installation.
 *   `currentForLimit` accepted a `workspaceId` and silently ignored it for those
 *   two, which read as a scoping bug rather than the documented single-workspace
 *   property it is.
 */

const counts = vi.hoisted(() => ({
  project: vi.fn(),
  user: vi.fn(),
  deployment: vi.fn(),
  workspaceUpsert: vi.fn(),
  planFindUnique: vi.fn(),
  planFindFirst: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    project: { count: counts.project },
    user: { count: counts.user },
    deployment: { count: counts.deployment },
    workspace: { upsert: counts.workspaceUpsert },
    plan: { findUnique: counts.planFindUnique, findFirst: counts.planFindFirst },
  },
}));

const { GLOBAL_LIMIT_KINDS, checkLimit, isUnlimited } = await import('@/lib/plans/limits');

const GIB = 1024 * 1024 * 1024;

function plan(overrides: Record<string, unknown> = {}) {
  return {
    id: 'plan_1',
    key: 'pro',
    maxProjects: 50,
    maxLiveSites: 10,
    maxPreviewSites: 25,
    maxMembers: 20,
    storageBytesLimit: BigInt(20 * GIB),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  counts.workspaceUpsert.mockResolvedValue({ id: 'ws_a', planId: 'plan_1', storageBytes: 0 });
  counts.planFindUnique.mockResolvedValue(plan());
  counts.project.mockResolvedValue(0);
  counts.user.mockResolvedValue(0);
  counts.deployment.mockResolvedValue(0);
});

describe('the storage limit is enforceable against a 32-bit counter', () => {
  it('clamps a 20 GiB plan limit to what the counter can hold', async () => {
    const result = await checkLimit('ws_a', 'storage', 1);

    expect(result.limit).toBe(MAX_TRACKABLE_STORAGE_BYTES);
    expect(result.limit).toBeLessThan(20 * GIB);
  });

  it('refuses a write that would push the counter past the ceiling', async () => {
    counts.workspaceUpsert.mockResolvedValue({
      id: 'ws_a',
      planId: 'plan_1',
      storageBytes: MAX_TRACKABLE_STORAGE_BYTES - 10,
    });

    const result = await checkLimit('ws_a', 'storage', 1024);

    // Pre-fix this passed — the comparison was against 20 GiB — and the caller's
    // `storageBytes` increment then errored out of range.
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('storage');
  });

  it('keeps a limit the counter can represent exactly as configured', async () => {
    counts.planFindUnique.mockResolvedValue(plan({ storageBytesLimit: BigInt(500 * 1024 * 1024) }));

    const result = await checkLimit('ws_a', 'storage', 1);

    expect(result.limit).toBe(500 * 1024 * 1024);
    expect(result.ok).toBe(true);
  });

  it('does not report storage as unlimited, because the column cannot be', async () => {
    counts.planFindUnique.mockResolvedValue(plan({ storageBytesLimit: BigInt(-1) }));

    const result = await checkLimit('ws_a', 'storage', 1);

    expect(isUnlimited(result.limit)).toBe(false);
    expect(result.limit).toBe(MAX_TRACKABLE_STORAGE_BYTES);
  });

  it('still honours unlimited for the kinds whose counter is not the constraint', async () => {
    counts.planFindUnique.mockResolvedValue(plan({ maxProjects: -1 }));
    counts.project.mockResolvedValue(9_000);

    const result = await checkLimit('ws_a', 'projects', 1);

    expect(isUnlimited(result.limit)).toBe(true);
    expect(result.ok).toBe(true);
  });
});

describe('which limit kinds are scoped by workspace', () => {
  it('names projects and members as global', () => {
    expect([...GLOBAL_LIMIT_KINDS].sort()).toEqual(['members', 'projects']);
  });

  it('does not scope the global kinds by workspace', async () => {
    await checkLimit('ws_a', 'projects', 1);
    await checkLimit('ws_a', 'members', 1);

    expect(counts.project).toHaveBeenCalledWith({ where: { deletedAt: null } });
    expect(counts.user).toHaveBeenCalledWith({ where: { isActive: true } });
  });

  it('scopes every other countable kind by workspace', async () => {
    await checkLimit('ws_a', 'liveSites', 1);
    await checkLimit('ws_a', 'previewSites', 1);

    for (const call of counts.deployment.mock.calls) {
      expect(call[0].where.workspaceId).toBe('ws_a');
    }
    expect(counts.deployment).toHaveBeenCalledTimes(2);
  });
});
