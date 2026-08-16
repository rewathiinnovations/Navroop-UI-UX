'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { CircleAlert } from 'lucide-react';
import StudioShell from '@/components/app/studio/StudioShell';
import StudioButton from '@/components/app/studio/StudioButton';
import StudioField from '@/components/app/studio/StudioField';
import PageTabs from '@/components/app/studio/PageTabs';
import { useAuth } from '@/components/app/auth/AuthProvider';
import { changePassword, updateProfile } from '@/lib/profile/actions';

function initials(name: string) {
  return (
    name
      .split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('') || 'N'
  );
}

export default function ProfileSettingsPage() {
  const { user } = useAuth();
  const { update } = useSession();
  const [name, setName] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [previewBroken, setPreviewBroken] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [profileMessage, setProfileMessage] = useState('');
  const [profileError, setProfileError] = useState('');
  const [passwordMessage, setPasswordMessage] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);

  useEffect(() => {
    if (!user) return;
    setName(user.name);
    setAvatarUrl(user.avatarUrl || '');
    setPreviewBroken(false);
  }, [user]);

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    setProfileError('');
    setProfileMessage('');
    setSavingProfile(true);
    try {
      const result = await updateProfile({ name, avatarUrl });
      if (!result.ok) {
        setProfileError(result.error);
        return;
      }
      await update({
        user: { name: result.data.name, avatarUrl: result.data.avatarUrl },
      });
      setName(result.data.name);
      setAvatarUrl(result.data.avatarUrl || '');
      setPreviewBroken(false);
      setProfileMessage('Profile saved.');
    } finally {
      setSavingProfile(false);
    }
  };

  const savePassword = async (event: FormEvent) => {
    event.preventDefault();
    setPasswordError('');
    setPasswordMessage('');
    if (newPassword !== confirmPassword) {
      setPasswordError('New password and confirmation do not match');
      return;
    }
    setSavingPassword(true);
    try {
      const result = await changePassword(currentPassword, newPassword);
      if (!result.ok) {
        setPasswordError(result.error);
        return;
      }
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordMessage('Password updated.');
    } finally {
      setSavingPassword(false);
    }
  };

  const previewUrl = avatarUrl.trim();
  const showImage = Boolean(previewUrl) && !previewBroken;

  return (
    <StudioShell variant="workspace">
      <main className="mx-auto max-w-[640px] px-20 py-40">
        <h1 className="text-[32px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">Settings</h1>
        <PageTabs
          items={[
            { href: '/settings/profile', label: 'Profile', active: true },
            { href: '/settings/api-keys', label: 'API Keys' },
          ]}
        />

        <form onSubmit={saveProfile} className="mb-40 space-y-16">
          <div className="flex items-center gap-16">
            <div className="flex size-64 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[var(--studio-line)] bg-[var(--studio-accent-soft)] text-[18px] font-medium text-[var(--studio-accent-hover)]">
              {showImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={previewUrl}
                  alt=""
                  className="size-64 rounded-full object-cover"
                  onError={() => setPreviewBroken(true)}
                />
              ) : (
                initials(name || user?.name || 'N')
              )}
            </div>
            <p className="text-[13px] text-[var(--studio-muted)]">
              Paste an image URL for your avatar.
              <span className="mt-4 block text-[12px] text-[var(--studio-faint)]">
                TODO: real upload needs storage provider.
              </span>
            </p>
          </div>

          <StudioField
            id="avatar-url"
            label="Avatar URL"
            type="url"
            value={avatarUrl}
            onChange={(event) => {
              setAvatarUrl(event.target.value);
              setPreviewBroken(false);
            }}
            placeholder="https://…"
          />
          <StudioField
            id="name"
            label="Name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            minLength={1}
            maxLength={100}
          />
          <div className="space-y-8">
            <StudioField id="email" label="Email" value={user?.email || ''} disabled readOnly />
            <p className="text-[12px] text-[var(--studio-muted)]">contact an admin to change this</p>
          </div>

          {profileError && (
            <p className="flex items-start gap-8 text-[13px] text-[var(--studio-danger)]" role="alert">
              <CircleAlert className="mt-2 size-16" aria-hidden />
              {profileError}
            </p>
          )}
          {profileMessage && <p className="text-[13px] text-[var(--studio-muted)]">{profileMessage}</p>}

          <StudioButton type="submit" variant="primary" disabled={savingProfile}>
            {savingProfile ? 'Saving…' : 'Save profile'}
          </StudioButton>
        </form>

        <form onSubmit={savePassword} className="space-y-16">
          <h2 className="text-[18px] font-medium text-[var(--studio-fg)]">Change password</h2>
          <StudioField
            id="current-password"
            label="Current password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            required
          />
          <StudioField
            id="new-password"
            label="New password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            required
            placeholder="At least 8 characters"
          />
          <StudioField
            id="confirm-password"
            label="Confirm new password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            required
          />
          {passwordError && (
            <p className="flex items-start gap-8 text-[13px] text-[var(--studio-danger)]" role="alert">
              <CircleAlert className="mt-2 size-16" aria-hidden />
              {passwordError}
            </p>
          )}
          {passwordMessage && <p className="text-[13px] text-[var(--studio-muted)]">{passwordMessage}</p>}
          <StudioButton type="submit" variant="ghost" disabled={savingPassword}>
            {savingPassword ? 'Updating…' : 'Update password'}
          </StudioButton>
        </form>
      </main>
    </StudioShell>
  );
}
