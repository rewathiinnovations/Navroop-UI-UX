'use client';

import AdminPage from '@/components/admin/AdminPage';
import ConfirmAction from '@/components/admin/ConfirmAction';
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
      title="Team"
      description="Who can sign in, what role they hold, and how to invite or deactivate them."
    >
      <div className="overflow-x-auto rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)]">
        <table className="w-full text-left text-[14px]">
          <thead className="border-b border-[var(--studio-line)] text-[12px] uppercase tracking-[0.08em] text-[var(--studio-faint)]">
            <tr>
              <th className="px-16 py-12 font-medium">Name</th>
              <th className="px-16 py-12 font-medium">Email</th>
              <th className="px-16 py-12 font-medium">Role</th>
              <th className="px-16 py-12 font-medium">Status</th>
              <th className="px-16 py-12 font-medium">Member since</th>
              <th className="px-16 py-12 font-medium">Projects</th>
              <th className="px-16 py-12 font-medium"> </th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <Fragment key={member.id}>
                <tr className="border-b border-[var(--studio-line)] last:border-0 align-top">
                  <td className="px-16 py-14 font-medium text-[var(--studio-fg)]">{member.name}</td>
                  <td className="px-16 py-14 text-[var(--studio-muted)]">{member.email}</td>
                  <td className="px-16 py-14">
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
                  </td>
                  <td className="px-16 py-14">
                    <span
                      className={
                        member.isActive
                          ? 'inline-flex rounded-full bg-[var(--studio-accent-soft)] px-10 py-4 text-[12px] font-medium text-[var(--studio-accent-hover)]'
                          : 'inline-flex rounded-full bg-[var(--studio-skeleton)] px-10 py-4 text-[12px] font-medium text-[var(--studio-muted)]'
                      }
                    >
                      {member.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-16 py-14 text-[var(--studio-muted)]">
                    {formatMemberSince(member.createdAt)}
                  </td>
                  <td className="px-16 py-14 text-[var(--studio-muted)]">
                    {member._count.projects}
                  </td>
                  <td className="px-16 py-14">
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
                  </td>
                </tr>
                {rowNotes[member.id] && (
                  <tr className="border-b border-[var(--studio-line)] last:border-0">
                    <td
                      colSpan={7}
                      className="px-16 pb-12 pt-0 text-[12px] text-[var(--studio-accent-hover)]"
                      role="status"
                    >
                      {rowNotes[member.id]}
                    </td>
                  </tr>
                )}
                {rowErrors[member.id] && (
                  <tr className="border-b border-[var(--studio-line)] last:border-0">
                    <td
                      colSpan={7}
                      className="px-16 pb-12 pt-0 text-[12px] text-[var(--studio-danger)]"
                      role="alert"
                    >
                      {rowErrors[member.id]}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </AdminPage>
  );
}
