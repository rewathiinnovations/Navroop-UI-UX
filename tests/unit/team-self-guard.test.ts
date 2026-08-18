import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SELF_DEACTIVATE_ERROR, SELF_ROLE_ERROR } from '@/lib/team/schema';

/**
 * The last-admin trigger protects the workspace's final admin, but with two
 * admins it let one demote or deactivate *themself* — an instant lockout the
 * UI happily offered on the admin's own row. These pin the refusal.
 */

const requireAdmin = vi.hoisted(() => vi.fn());
const prisma = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  },
}));
const lastAdmin = vi.hoisted(() => ({
  wouldRemoveLastAdmin: vi.fn(),
  isLastAdminDbError: vi.fn(() => false),
}));
const writeAudit = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth', () => ({ requireAdmin }));
vi.mock('@/lib/db', () => ({ prisma }));
vi.mock('@/lib/team/last-admin', () => lastAdmin);
vi.mock('@/lib/audit/log', () => ({ writeAudit }));
vi.mock('@/lib/plans/limits', () => ({ checkLimit: vi.fn() }));
vi.mock('@/lib/plans/http', () => ({ asCreditActionErr: vi.fn() }));

const SELF = { id: 'admin-1', email: 'admin@navroop.local', role: 'ADMIN' };
const OTHER_ID = 'admin-2';

describe('team actions refuse self-management', () => {
  beforeEach(() => {
    requireAdmin.mockReset();
    prisma.user.findUnique.mockReset();
    prisma.user.update.mockReset();
    lastAdmin.wouldRemoveLastAdmin.mockReset();
    writeAudit.mockReset();
    requireAdmin.mockResolvedValue({ user: SELF, error: null, status: 200 });
    lastAdmin.wouldRemoveLastAdmin.mockResolvedValue(false);
  });

  it('updateMemberRole refuses the caller demoting themself, even with another admin', async () => {
    const { updateMemberRole } = await import('@/lib/team/actions');
    const result = await updateMemberRole(SELF.id, 'MEMBER');
    expect(result).toMatchObject({ ok: false, error: SELF_ROLE_ERROR, status: 400 });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('deactivateMember refuses the caller deactivating themself', async () => {
    const { deactivateMember } = await import('@/lib/team/actions');
    const result = await deactivateMember(SELF.id);
    expect(result).toMatchObject({ ok: false, error: SELF_DEACTIVATE_ERROR, status: 400 });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('still updates another member normally', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: OTHER_ID, role: 'ADMIN', isActive: true });
    prisma.user.update.mockResolvedValue({
      id: OTHER_ID,
      name: 'Other',
      email: 'other@navroop.local',
      role: 'MEMBER',
      isActive: true,
      createdAt: new Date(),
      _count: { projects: 0 },
    });
    const { updateMemberRole } = await import('@/lib/team/actions');
    const result = await updateMemberRole(OTHER_ID, 'MEMBER');
    expect(result.ok).toBe(true);
    expect(prisma.user.update).toHaveBeenCalledOnce();
  });
});
