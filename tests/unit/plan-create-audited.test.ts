import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REQUIRED_AUDIT_ACTIONS } from '@/lib/audit/log';
import type { WriteAuditInput } from '@/lib/audit/log';

/**
 * F-316: `createPlan` wrote no `AuditLog` row while both its siblings did —
 * `updatePlan` writes `plan.limits_edit` and `assignDefaultWorkspacePlan` writes
 * `plan.assign`. So `/admin/audit` could show a limit set being edited and put
 * into service with no record of how it came to exist, even though a plan defines
 * credit ceilings, project/site/member limits and the per-job token caps.
 */

const ADMIN = { id: 'user_plan_audit_admin', email: 'plan-audit@navroop.local', role: 'ADMIN' };

const writeAudit = vi.hoisted(() => vi.fn());
const planCreate = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth', () => ({
  requireAdmin: async () => ({ user: ADMIN, error: null, status: 200 }),
  getSessionUser: async () => ADMIN,
}));
vi.mock('@/lib/audit/log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit/log')>()),
  writeAudit,
}));
vi.mock('@/lib/db', () => ({ prisma: { plan: { create: planCreate } } }));

const { createPlan } = await import('@/lib/plans/actions');

const ROW = {
  id: 'plan_created_1',
  key: 'enterprise',
  name: 'Enterprise',
  isActive: true,
  isDefault: false,
  monthlyCredits: 5000,
  maxProjects: 50,
  maxLiveSites: 10,
  maxPreviewSites: 25,
  maxMembers: 20,
  checkpointRetentionDays: 30,
  storageBytesLimit: BigInt(21_474_836_480),
  allowCustomDomain: true,
  allowGithubSync: true,
  maxTokensPerJob: 200_000,
  maxFilesPerJob: 60,
  maxOutputBytesPerJob: 2_000_000,
};

const INPUT = {
  key: 'Enterprise',
  name: 'Enterprise',
  monthlyCredits: 5000,
  maxProjects: 50,
  maxLiveSites: 10,
  maxPreviewSites: 25,
  maxMembers: 20,
  checkpointRetentionDays: 30,
  storageBytesLimit: '21474836480',
};

beforeEach(() => {
  vi.clearAllMocks();
  planCreate.mockResolvedValue(ROW);
});

describe('createPlan leaves an audit trail', () => {
  it('lists plan.create as a required action', () => {
    expect(REQUIRED_AUDIT_ACTIONS).toContain('plan.create');
  });

  it('writes a plan.create row naming the actor, the plan and its limits', async () => {
    const result = await createPlan(INPUT);
    expect(result.ok).toBe(true);

    expect(writeAudit).toHaveBeenCalledTimes(1);
    const entry = writeAudit.mock.calls[0][0] as WriteAuditInput;
    expect(entry.action).toBe('plan.create');
    expect(entry.actorId).toBe(ADMIN.id);
    expect(entry.actorEmail).toBe(ADMIN.email);
    expect(entry.targetType).toBe('plan');
    expect(entry.targetId).toBe(ROW.id);
    expect(entry.after).toMatchObject({
      key: 'enterprise',
      monthlyCredits: 5000,
      maxProjects: 50,
      maxLiveSites: 10,
      maxPreviewSites: 25,
      maxMembers: 20,
      // Serialised: a BigInt cannot be JSON-stringified into the audit row.
      storageBytesLimit: '21474836480',
      isActive: true,
    });
  });

  it('writes nothing when the create is refused', async () => {
    const result = await createPlan({ ...INPUT, key: '   ' });

    expect(result.ok).toBe(false);
    expect(planCreate).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });
});
