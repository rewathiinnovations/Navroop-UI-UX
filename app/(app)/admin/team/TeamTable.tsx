'use client';

import AdminPage from '@/components/admin/AdminPage';
import { AdminTable, Td, Th, Tr } from '@/components/admin/AdminTable';
import ConfirmAction from '@/components/admin/ConfirmAction';
import StatusPill from '@/components/admin/StatusPill';
import { Users } from 'lucide-react';
import { Fragment, useState } from 'react';
import StudioButton from '@/components/app/studio/StudioButton';
import { deactivateMember, listTeam, reactivateMember, updateMemberRole } from '@/lib/team/actions';
import type { TeamRole } from '@/lib/team/schema';
import { formatAdminDate } from '../format-admin-date';

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

export default function TeamTable({ initialMembers }: { initialMembers: Member[] }) {
  const [members, setMembers] = useState(initialMembers);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [rowNotes, setRowNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async () => {
    const result = await listTeam();
    if (result.ok) setMembers(result.data.members);
  };

  const setRowError = (userId: string, message: string) => {
    setRowErrors((current) => ({ ...current, [userId]: message }));
  };

  const clearRowError = (userId: string) => {
    setRowErrors((current) => {
      const next = { ...current };
      delete next[userId];
      return next;
    });
  };

  const onRole = async (userId: string, role: TeamRole) => {
    setBusy(`role:${userId}`);
    clearRowError(userId);
    try {
      const result = await updateMemberRole(userId, role);
      if (!result.ok) {
        setRowError(userId, result.error);
        return;
      }
      setMembers((current) =>
        current.map((member) => (member.id === userId ? result.data : member)),
      );
    } finally {
      setBusy(null);
    }
  };

  const onSendReset = async (member: Member) => {
    setBusy(`reset:${member.id}`);
    clearRowError(member.id);
    setRowNotes((current) => {
      const next = { ...current };
      delete next[member.id];
      return next;
    });
    try {
      const response = await fetch(`/api/admin/team/${member.id}/reset-link`, { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setRowError(member.id, data.error || 'Could not send the link');
        return;
      }
      setRowNotes((current) => ({ ...current, [member.id]: 'Reset link sent' }));
    } finally {
      setBusy(null);
    }
  };

  const onToggleActive = async (member: Member) => {
    setBusy(`active:${member.id}`);
    clearRowError(member.id);
    try {
      const result = member.isActive
        ? await deactivateMember(member.id)
        : await reactivateMember(member.id);
      if (!result.ok) {
        setRowError(member.id, result.error);
        return;
      }
      setMembers((current) => current.map((row) => (row.id === member.id ? result.data : row)));
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  return (
    <AdminPage
      icon="team"
      title="Team"
      description="Who can sign in, what role they hold, and how to invite or deactivate them."
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
                  disabled={busy === `role:${member.id}`}
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
                  {member.isActive ? (
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
            {rowNotes[member.id] && (
              <Tr>
                <Td className="pt-0" colSpan={7}>
                  <span className="text-[12px] text-[var(--studio-accent)]" role="status">
                    {rowNotes[member.id]}
                  </span>
                </Td>
              </Tr>
            )}
            {rowErrors[member.id] && (
              <Tr>
                <Td className="pt-0" colSpan={7}>
                  <span className="text-[12px] text-[var(--studio-danger)]" role="alert">
                    {rowErrors[member.id]}
                  </span>
                </Td>
              </Tr>
            )}
          </Fragment>
        ))}
      </AdminTable>
    </AdminPage>
  );
}
