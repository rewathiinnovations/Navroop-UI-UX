import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REQUIRED_AUDIT_ACTIONS } from '@/lib/audit/log';
import type * as AuditLogModule from '@/lib/audit/log';

/**
 * F-744: `updateMemberRole` and `deactivateMember` both wrote an audit entry;
 * `reactivateMember` flipped `isActive` back to true and returned silently. In
 * an invite-only workspace where project reads are workspace-wide, restoring
 * someone's access is the single most consequential membership change there
 * is, and the trail read as though the account were still disabled.
 *
 * Two guards: the behavioural one (reactivation writes `member.reactivate`
 * with before/after), and a source scan pairing every `user.update` in
 * `lib/team/actions.ts` with a `writeAudit`, so the next mutation added here
 * cannot land without one.
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
  wouldRemoveLastAdmin: vi.fn(async () => false),
  isLastAdminDbError: vi.fn(() => false),
}));
const writeAudit = vi.hoisted(() => vi.fn());
const limits = vi.hoisted(() => ({
  // Runs the callback against the same `prisma` double the un-transacted
  // paths use, so a reservation behaves like the real one: the write happens
  // inside it and its result is handed back as `data`.
  withLimit: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ requireAdmin }));
vi.mock('@/lib/db', () => ({ prisma }));
vi.mock('@/lib/team/last-admin', () => lastAdmin);
vi.mock('@/lib/audit/log', async (importOriginal) => ({
  ...(await importOriginal<typeof AuditLogModule>()),
  writeAudit,
}));
vi.mock('@/lib/plans/limits', () => limits);
vi.mock('@/lib/plans/http', () => ({
  asCreditActionErr: (input: { message?: string }) => ({
    ok: false as const,
    error: input.message ?? 'limit',
    status: 402,
  }),
}));

const ADMIN = { id: 'admin-1', email: 'admin@navroop.local', role: 'ADMIN' };
const TARGET = 'member-9';

function memberRow(isActive: boolean) {
  return {
    id: TARGET,
    name: 'Member',
    email: 'member@navroop.local',
    role: 'MEMBER',
    isActive,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    _count: { projects: 0 },
  };
}

describe('reactivateMember leaves an audit trail (F-744)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAdmin.mockResolvedValue({ user: ADMIN, error: null, status: 200 });
    lastAdmin.wouldRemoveLastAdmin.mockResolvedValue(false);
    lastAdmin.isLastAdminDbError.mockReturnValue(false);
    limits.withLimit.mockImplementation(
      async (
        _workspaceId: string,
        _kind: string,
        _upcoming: number,
        create: (tx: typeof prisma) => Promise<unknown>,
      ) => ({ ok: true as const, data: await create(prisma) }),
    );
  });

  it('writes member.reactivate with the isActive transition', async () => {
    prisma.user.findUnique.mockResolvedValue(memberRow(false));
    prisma.user.update.mockResolvedValue(memberRow(true));

    const { reactivateMember } = await import('@/lib/team/actions');
    const result = await reactivateMember(TARGET);

    expect(result).toMatchObject({ ok: true });
    expect(writeAudit).toHaveBeenCalledTimes(1);
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: ADMIN.id,
        actorEmail: ADMIN.email,
        action: 'member.reactivate',
        targetType: 'user',
        targetId: TARGET,
        before: { isActive: false },
        after: { isActive: true },
      }),
    );
  });

  it('writes nothing when the reservation is refused', async () => {
    prisma.user.findUnique.mockResolvedValue(memberRow(false));
    limits.withLimit.mockResolvedValue({
      ok: false as const,
      current: 5,
      limit: 5,
      reason: 'members',
      message: 'Member limit reached',
    });

    const { reactivateMember } = await import('@/lib/team/actions');
    const result = await reactivateMember(TARGET);

    expect(result).toMatchObject({ ok: false, status: 402 });
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('lists member.reactivate as a required action', () => {
    expect(REQUIRED_AUDIT_ACTIONS).toContain('member.reactivate');
  });
});

describe('every membership mutation is paired with an audit write', () => {
  it('has a writeAudit call for each user.update in lib/team/actions.ts', () => {
    const source = readFileSync(join(process.cwd(), 'lib/team/actions.ts'), 'utf8');
    // Counts `prisma.user.update(` and `tx.user.update(` alike: a reservation
    // writes through the transaction client, and both are membership changes.
    const updates = source.match(/\b\w+\.user\.update\(/g) ?? [];
    const audits = source.match(/\bwriteAudit\(/g) ?? [];
    expect(updates.length).toBeGreaterThan(0);
    expect(audits.length).toBeGreaterThanOrEqual(updates.length);
  });
});
