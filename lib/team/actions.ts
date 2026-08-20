'use server';

import { Prisma } from '@/generated/prisma';
import { prisma } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import { isLastAdminDbError, wouldRemoveLastAdmin } from '@/lib/team/last-admin';
import { pendingInviteEmails } from '@/lib/invites/service';
import { writeAudit } from '@/lib/audit/log';
import {
  memberIdSchema,
  parseWithZod,
  SELF_DEACTIVATE_ERROR,
  SELF_ROLE_ERROR,
  updateMemberRoleSchema,
  type TeamRole,
} from '@/lib/team/schema';
import { asCreditActionErr } from '@/lib/plans/http';
import { withLimit } from '@/lib/plans/limits';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';

export type ActionOk<T> = { ok: true; data: T };
export type ActionErr = {
  ok: false;
  error: string;
  status: number;
  details?: unknown;
};
export type ActionResult<T> = ActionOk<T> | ActionErr;

const LAST_ADMIN_ERROR = "Can't remove the last admin";

const memberSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  isActive: true,
  createdAt: true,
  _count: { select: { projects: true } },
} as const;

async function adminGate() {
  const result = await requireAdmin();
  if (!result.user) {
    return { user: null, err: { ok: false as const, error: result.error, status: result.status } };
  }
  return { user: result.user, err: null };
}

function notFound(): ActionErr {
  return { ok: false, error: 'User not found', status: 404 };
}

function lastAdminErr(): ActionErr {
  return { ok: false, error: LAST_ADMIN_ERROR, status: 400 };
}

/**
 * The last-admin trigger already stops the workspace losing its final admin,
 * but with two admins it happily let one demote or deactivate *themself* —
 * an instant lockout with no one to blame but the UI that offered the button.
 */
function selfErr(error: string): ActionErr {
  return { ok: false, error, status: 400 };
}

async function loadMember(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: memberSelect,
  });
}

/**
 * `invitePending` is the honest half of F-351: a member row created by an invite looks
 * exactly like an active one until the invitee opens the link and sets a password. The
 * flag comes from the `Invite` table (live token, not accepted, not revoked), not from
 * guessing at `passwordChangedAt`.
 */
export async function listTeam() {
  const { err } = await adminGate();
  if (err) return err;

  const [rows, pending] = await Promise.all([
    prisma.user.findMany({ orderBy: { createdAt: 'asc' }, select: memberSelect }),
    pendingInviteEmails(),
  ]);
  const members = rows.map((row) => ({ ...row, invitePending: pending.has(row.email) }));
  return { ok: true as const, data: { members } };
}

export async function updateMemberRole(userId: string, role: TeamRole) {
  const { user, err } = await adminGate();
  if (err) return err;

  const parsed = parseWithZod(updateMemberRoleSchema, { userId, role });
  if (!parsed.ok) return parsed;

  if (parsed.data.userId === user.id) return selfErr(SELF_ROLE_ERROR);

  const existing = await loadMember(parsed.data.userId);
  if (!existing) return notFound();

  if (await wouldRemoveLastAdmin(parsed.data.userId, parsed.data.role)) {
    return lastAdminErr();
  }

  try {
    const member = await prisma.user.update({
      where: { id: parsed.data.userId },
      data: { role: parsed.data.role },
      select: memberSelect,
    });
    await writeAudit({
      actorId: user.id,
      actorEmail: user.email,
      action: 'member.role_change',
      targetType: 'user',
      targetId: member.id,
      before: { role: existing.role },
      after: { role: member.role },
    });
    return { ok: true as const, data: member };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      return notFound();
    }
    if (isLastAdminDbError(error)) return lastAdminErr();
    throw error;
  }
}

export async function deactivateMember(userId: string) {
  const { user, err } = await adminGate();
  if (err) return err;

  const parsed = parseWithZod(memberIdSchema, { userId });
  if (!parsed.ok) return parsed;

  if (parsed.data.userId === user.id) return selfErr(SELF_DEACTIVATE_ERROR);

  const existing = await loadMember(parsed.data.userId);
  if (!existing) return notFound();

  if (await wouldRemoveLastAdmin(parsed.data.userId, false)) {
    return lastAdminErr();
  }

  try {
    const member = await prisma.user.update({
      where: { id: parsed.data.userId },
      data: { isActive: false },
      select: memberSelect,
    });
    await writeAudit({
      actorId: user.id,
      actorEmail: user.email,
      action: 'member.deactivate',
      targetType: 'user',
      targetId: member.id,
      before: { isActive: existing.isActive },
      after: { isActive: member.isActive },
    });
    return { ok: true as const, data: member };
  } catch (error) {
    if (isLastAdminDbError(error)) return lastAdminErr();
    throw error;
  }
}

export async function reactivateMember(userId: string) {
  const { user, err } = await adminGate();
  if (err) return err;

  const parsed = parseWithZod(memberIdSchema, { userId });
  if (!parsed.ok) return parsed;

  const existing = await loadMember(parsed.data.userId);
  if (!existing) return notFound();

  // Reactivation is a create as far as the members ceiling is concerned — it is what
  // `currentForLimit` counts — so it is enforced at the write (F-307). Two concurrent
  // reactivations at the ceiling both counted `limit - 1` and both committed.
  const reserved = await withLimit(WORKSPACE_ROW_ID, 'members', 1, (tx) =>
    tx.user.update({
      where: { id: parsed.data.userId },
      data: { isActive: true },
      select: memberSelect,
    }),
  );
  if (!reserved.ok) return asCreditActionErr(reserved);
  const member = reserved.data;
  // Restoring access to an invite-only workspace — and, since project reads are
  // workspace-wide, to every project in it — is at least as consequential as the
  // deactivation above. Without this the trail read as though the account were
  // still disabled (F-744).
  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: 'member.reactivate',
    targetType: 'user',
    targetId: member.id,
    before: { isActive: existing.isActive },
    after: { isActive: member.isActive },
  });
  return { ok: true as const, data: member };
}
