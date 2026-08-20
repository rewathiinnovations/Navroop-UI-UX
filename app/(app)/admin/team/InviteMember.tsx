'use client';

import { useEffect, useState } from 'react';
import StudioButton from '@/components/app/studio/StudioButton';
import StudioField from '@/components/app/studio/StudioField';
import StudioModal from '@/components/ui/StudioModal';
import { notify, toMessage } from '@/lib/notify';
import type { TeamRole } from '@/lib/team/schema';

/**
 * The missing half of an invite-only product: the invite.
 *
 * This dialog used to show a temporary password exactly once and leave the admin to relay
 * it over whatever channel they picked. It now creates a *pending* invitation and mails a
 * single-use link the invitee redeems at `/accept-invite`, choosing their own password
 * (F-351). Submitting the same address again while its invite is still outstanding rotates
 * the link — which is the only honest answer to "it never arrived".
 */

export type InvitedMember = {
  id: string;
  name: string;
  email: string;
  role: TeamRole;
  createdAt: string;
};

type InviteResult = {
  member: InvitedMember;
  invite: {
    expiresAt: string;
    emailed: boolean;
    emailError: string | null;
    resent: boolean;
  };
};

export default function InviteMember({
  onInvited,
}: {
  onInvited: (member: InvitedMember) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TeamRole>('MEMBER');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<InviteResult | null>(null);

  useEffect(() => {
    if (open) {
      setName('');
      setEmail('');
      setRole('MEMBER');
      setError(null);
      setCreated(null);
    }
  }, [open]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name, role }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.error || 'Could not create the invite');
        return;
      }
      setCreated({ member: data.member, invite: data.invite });
      onInvited(data.member);
      // Confirms the row was added to the table behind the dialog, and stays
      // on screen after the dialog is dismissed.
      notify.success(
        data.invite?.emailed
          ? `Invite sent to ${data.member.email}.`
          : `${data.member.email} added — the invite email did not go out.`,
      );
    } catch (cause) {
      setError(toMessage(cause, 'Could not create the invite'));
    } finally {
      setBusy(false);
    }
  };

  const expiryLabel = created
    ? new Date(created.invite.expiresAt).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : '';

  return (
    <>
      <StudioButton type="button" variant="primary" onClick={() => setOpen(true)}>
        Invite member
      </StudioButton>

      <StudioModal
        open={open}
        onOpenChange={setOpen}
        dismissible={!busy}
        title={
          created ? (created.invite.resent ? 'Invite resent' : 'Invite sent') : 'Invite a member'
        }
        titleClassName="text-[16px] font-medium text-[var(--studio-fg)]"
        className="studio-pop-in relative z-10 w-full max-w-[440px] rounded-16 border border-[var(--studio-line)] bg-[var(--studio-surface)] p-24 shadow-[var(--studio-shadow-pop)]"
      >
        {created ? (
          <div className="mt-12 space-y-16">
            {created.invite.emailed ? (
              <p className="text-[14px] leading-6 text-[var(--studio-muted)]">
                A single-use link is on its way to{' '}
                <span className="font-medium text-[var(--studio-fg)]">{created.member.email}</span>.
                They choose their own password — no password is shown here, and none needs to be
                passed on. The link works once and expires on {expiryLabel}. Invite the same address
                again to replace it with a fresh link.
              </p>
            ) : (
              <div className="space-y-8" role="alert">
                <p className="text-[14px] leading-6 text-[var(--studio-danger)]">
                  {created.member.email} was added, but the invite email could not be sent, so
                  nobody has the link. Fix email delivery in Admin → Configuration, then invite this
                  address again to send a fresh link.
                </p>
                {created.invite.emailError && (
                  <p className="text-[13px] leading-5 text-[var(--studio-muted)]">
                    Mail provider said: {created.invite.emailError}
                  </p>
                )}
              </div>
            )}
            <div className="flex justify-end">
              <StudioButton type="button" variant="primary" onClick={() => setOpen(false)}>
                Done
              </StudioButton>
            </div>
          </div>
        ) : (
          <form
            className="mt-12 space-y-16"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <StudioField
              id="invite-email"
              label="Email"
              type="email"
              required
              autoComplete="off"
              autoFocus
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <StudioField
              id="invite-name"
              label="Name (optional)"
              type="text"
              autoComplete="off"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <div className="space-y-8">
              <label
                htmlFor="invite-role"
                className="block text-[13px] font-medium text-[var(--studio-fg)]"
              >
                Role
              </label>
              <select
                id="invite-role"
                value={role}
                onChange={(event) => setRole(event.target.value as TeamRole)}
                className="h-44 w-full rounded-full border border-[var(--studio-line-strong)] bg-[var(--studio-surface)] px-16 text-[15px] text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
              >
                <option value="MEMBER">Member</option>
                <option value="ADMIN">Admin</option>
              </select>
            </div>

            {error && (
              <p className="text-[13px] text-[var(--studio-danger)]" role="alert">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-8">
              <StudioButton
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                Cancel
              </StudioButton>
              <StudioButton type="submit" variant="primary" disabled={busy || !email.trim()}>
                {busy ? 'Sending…' : 'Send invite'}
              </StudioButton>
            </div>
          </form>
        )}
      </StudioModal>
    </>
  );
}
