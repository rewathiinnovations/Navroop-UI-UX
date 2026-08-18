'use client';

import AdminPage from '@/components/admin/AdminPage';
import { AdminTable, Td, Th, Tr } from '@/components/admin/AdminTable';
import ConfirmAction from '@/components/admin/ConfirmAction';
import StatusPill from '@/components/admin/StatusPill';
import { Users } from 'lucide-react';
import { Fragment, useState } from 'react';
import StudioButton from '@/components/app/studio/StudioButton';
import { notify } from '@/lib/notify';
import { deactivateMember, listTeam, reactivateMember, updateMemberRole } from '@/lib/team/actions';
import { SELF_DEACTIVATE_ERROR, SELF_ROLE_ERROR, type TeamRole } from '@/lib/team/schema';
import { formatAdminDate } from '../format-admin-date';
import InviteMember, { type InvitedMember } from './InviteMember';

type Member = {
  id: string;
  name: string;
  email: string;
  role: TeamRole;
  isActive: boolean;
  createdAt: string | Date;
  _count: { projects: number };
};

function formatMemberSince(value: string | Date) {
  return formatAdminDate(value);
}

export default function TeamTable({
  initialMembers,
  selfId,
}: {
  initialMembers: Member[];
  selfId: string;
}) {
  const [members, setMembers] = useState(initialMembers);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async () => {
    const result = await listTeam();
    if (result.ok) setMembers(result.data.members);
  };

  // Row feedback is toasted rather than rendered as an extra table row. Each
  // toast is keyed by member so a repeated action replaces its own message
  // instead of stacking, and names the member since the toast sits away from
  // the row it describes.
  const onRole = async (userId: string, role: TeamRole) => {
    setBusy(`role:${userId}`);
    try {
      const result = await updateMemberRole(userId, role);
      if (!result.ok) {
        notify.error(result.error, { key: `team-${userId}` });
        return;
      }
      setMembers((current) =>
        current.map((member) => (member.id === userId ? result.data : member)),
      );
      notify.success(`${result.data.email} is now ${role === 'ADMIN' ? 'an admin' : 'a member'}.`, {
        key: `team-${userId}`,
      });
    } catch (cause) {
      notify.error(cause, { fallback: 'Could not change the role', key: `team-${userId}` });
    } finally {
      setBusy(null);
    }
  };

  const onSendReset = async (member: Member) => {
    setBusy(`reset:${member.id}`);
    try {
      const response = await fetch(`/api/admin/team/${member.id}/reset-link`, { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        notify.error(data.error || 'Could not send the link', { key: `team-${member.id}` });
        return;
      }
      notify.success(`Reset link sent to ${member.email}.`, { key: `team-${member.id}` });
    } catch (cause) {
      notify.error(cause, { fallback: 'Could not send the link', key: `team-${member.id}` });
    } finally {
      setBusy(null);
    }
  };

  const onToggleActive = async (member: Member) => {
    setBusy(`active:${member.id}`);
    try {
      const result = member.isActive
        ? await deactivateMember(member.id)
        : await reactivateMember(member.id);
      if (!result.ok) {
        notify.error(result.error, { key: `team-${member.id}` });
        return;
      }
      setMembers((current) => current.map((row) => (row.id === member.id ? result.data : row)));
      notify.success(
        member.isActive
          ? `${member.email} deactivated — they can no longer sign in.`
          : `${member.email} reactivated.`,
        { key: `team-${member.id}` },
      );
    } catch (cause) {
      notify.error(cause, { fallback: 'Could not update the member', key: `team-${member.id}` });
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const onInvited = (invited: InvitedMember) => {
    setMembers((current) => [
      ...current,
      { ...invited, isActive: true, _count: { projects: 0 } },
    ]);
  };

  return (
    <AdminPage
      icon="team"
      title="Team"
      description="Who can sign in, what role they hold, and how to invite or deactivate them."
      actions={<InviteMember onInvited={onInvited} />}
    >
      <AdminTable
        isEmpty={members.length === 0}
        empty={
          <span className="flex flex-col items-center gap-4">
            <Users className="size-16" aria-hidden /> No members yet.
          </span>
        }
        head={
          <>
            <Th>Name</Th>
            <Th>Email</Th>
            <Th>Role</Th>
            <Th>Status</Th>
            <Th>Member since</Th>
            <Th align="right">Projects</Th>
            <Th> </Th>
          </>
        }
      >
        {members.map((member) => (
          <Fragment key={member.id}>
            <Tr className="align-top">
              <Td>
                <div className="flex items-center gap-10">
                  <span className="inline-flex size-26 shrink-0 items-center justify-center rounded-full bg-[var(--studio-accent-soft)] text-[11px] font-medium text-[var(--studio-accent)]">
                    {(member.name || member.email).slice(0, 1).toUpperCase()}
                  </span>
                  <span className="font-medium text-[var(--studio-fg)]">{member.name}</span>
                </div>
              </Td>
              <Td muted>{member.email}</Td>
              <Td>
                <label className="sr-only" htmlFor={`role-${member.id}`}>
                  Role for {member.name}
                </label>
                <select
                  id={`role-${member.id}`}
                  value={member.role}
                  disabled={busy === `role:${member.id}` || member.id === selfId}
                  title={member.id === selfId ? SELF_ROLE_ERROR : undefined}
                  onChange={(event) => onRole(member.id, event.target.value as TeamRole)}
                  className="h-36 rounded-full border border-[var(--studio-line-strong)] bg-[var(--studio-surface)] px-12 text-[13px] text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
                >
                  <option value="ADMIN">Admin</option>
                  <option value="MEMBER">Member</option>
                </select>
              </Td>
              <Td>
                <StatusPill tone={member.isActive ? 'positive' : 'neutral'}>
                  {member.isActive ? 'Active' : 'Inactive'}
                </StatusPill>
              </Td>
              <Td muted>{formatMemberSince(member.createdAt)}</Td>
              <Td align="right" muted>
                {member._count.projects}
              </Td>
              <Td align="right">
                <div className="flex flex-col items-end gap-8">
                  {member.isActive && (
                    <StudioButton
                      type="button"
                      variant="ghost"
                      disabled={busy === `reset:${member.id}`}
                      onClick={() => onSendReset(member)}
                    >
                      {busy === `reset:${member.id}` ? 'Sending…' : 'Send reset link'}
                    </StudioButton>
                  )}
                  {member.id === selfId ? (
                    <span
                      className="text-[12px] text-[var(--studio-faint)]"
                      title={SELF_DEACTIVATE_ERROR}
                    >
                      This is you
                    </span>
                  ) : member.isActive ? (
                    <ConfirmAction
                      label="Deactivate"
                      title={`Deactivate ${member.name || member.email}?`}
                      body="They will be signed out and will not be able to sign in again until reactivated. Their projects are kept."
                      confirmLabel="Deactivate"
                      busyLabel="Deactivating…"
                      disabled={busy === `active:${member.id}`}
                      onConfirm={() => onToggleActive(member)}
                    />
                  ) : (
                    <StudioButton
                      type="button"
                      variant="ghost"
                      disabled={busy === `active:${member.id}`}
                      onClick={() => onToggleActive(member)}
                    >
                      Reactivate
                    </StudioButton>
                  )}
                </div>
              </Td>
            </Tr>
          </Fragment>
        ))}
      </AdminTable>
    </AdminPage>
  );
}
