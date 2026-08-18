'use client';

import { useEffect, useState } from 'react';
import StudioButton from '@/components/app/studio/StudioButton';
import StudioField from '@/components/app/studio/StudioField';
import type { TeamRole } from '@/lib/team/schema';

/**
 * The missing half of an invite-only product: the invite.
 *
 * `POST /api/admin/invite` had existed for some time, but no page rendered a
 * way to call it — the Team page promised "how to invite" in its description
 * and offered nothing. This dialog creates the account and shows the
 * temporary password exactly once; after it closes, the only path back in is
 * the per-row "Send reset link".
 */

export type InvitedMember = {
  id: string;
  name: string;
  email: string;
  role: TeamRole;
  createdAt: string;
};

type InviteSuccess = { member: InvitedMember; temporaryPassword: string };

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
  const [created, setCreated] = useState<InviteSuccess | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, busy]);

  useEffect(() => {
    if (open) {
      setName('');
      setEmail('');
      setRole('MEMBER');
      setError(null);
      setCreated(null);
      setCopied(false);
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
      setCreated({ member: data.member, temporaryPassword: data.temporaryPassword });
      onInvited(data.member);
    } finally {
      setBusy(false);
    }
  };

  const copyPassword = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.temporaryPassword);
      setCopied(true);
    } catch {
      // Clipboard can be unavailable (permissions, http); the password is
      // visible on screen, so selecting it by hand still works.
      setCopied(false);
    }
  };

  return (
    <>
      <StudioButton type="button" variant="primary" onClick={() => setOpen(true)}>
        Invite member
      </StudioButton>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-20">
          <button
            type="button"
            aria-label="Close"
            disabled={busy}
            className="studio-fade-in absolute inset-0 bg-[var(--studio-fg)]/20"
            onClick={() => setOpen(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="invite-member-title"
            className="studio-pop-in relative z-10 w-full max-w-[440px] rounded-16 border border-[var(--studio-line)] bg-[var(--studio-surface)] p-24 shadow-[var(--studio-shadow-pop)]"
          >
            <h2
              id="invite-member-title"
              className="text-[16px] font-medium text-[var(--studio-fg)]"
            >
              {created ? 'Member created' : 'Invite a member'}
            </h2>

            {created ? (
              <div className="mt-12 space-y-16">
                <p className="text-[14px] leading-6 text-[var(--studio-muted)]">
                  <span className="font-medium text-[var(--studio-fg)]">
                    {created.member.email}
                  </span>{' '}
                  can sign in with this temporary password. It is shown only once — share it
                  securely, and ask them to change it after signing in. You can also send them
                  a reset link from the table at any time.
                </p>
                <div className="flex items-center gap-8">
                  <code className="flex-1 truncate rounded-10 border border-[var(--studio-line-strong)] bg-[var(--studio-bg)] px-12 py-10 font-mono text-[14px] text-[var(--studio-fg)]">
                    {created.temporaryPassword}
                  </code>
                  <StudioButton type="button" variant="ghost" onClick={copyPassword}>
                    {copied ? 'Copied' : 'Copy'}
                  </StudioButton>
                </div>
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
                    {busy ? 'Creating…' : 'Create invite'}
                  </StudioButton>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
