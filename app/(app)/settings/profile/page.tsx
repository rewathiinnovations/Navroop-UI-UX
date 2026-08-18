'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { CircleAlert } from 'lucide-react';
import StudioShell from '@/components/app/studio/StudioShell';
import StudioButton from '@/components/app/studio/StudioButton';
import StudioField from '@/components/app/studio/StudioField';
import PageTabs from '@/components/app/studio/PageTabs';
import { useAuth } from '@/components/app/auth/AuthProvider';
import { changePassword, updateProfile, uploadAvatar } from '@/lib/profile/actions';
import { notify } from '@/lib/notify';
import StorageUsage from '@/components/settings/StorageUsage';

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
  // Only the local password-mismatch check renders inline, next to the fields
  // it refers to. Every server outcome is toasted instead.
  const [passwordError, setPasswordError] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [dataRequesting, setDataRequesting] = useState(false);

  useEffect(() => {
    if (!user) return;
    setName(user.name);
    setAvatarUrl(user.avatarUrl || '');
    setPreviewBroken(false);
  }, [user]);

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    setSavingProfile(true);
    try {
      const result = await updateProfile({ name, avatarUrl });
      if (!result.ok) {
        notify.error(result.error, { key: 'profile-save' });
        return;
      }
      await update({
        user: { name: result.data.name, avatarUrl: result.data.avatarUrl },
      });
      setName(result.data.name);
      setAvatarUrl(result.data.avatarUrl || '');
      setPreviewBroken(false);
      notify.success('Profile saved.', { key: 'profile-save' });
    } catch (cause) {
      notify.error(cause, { fallback: 'Could not save your profile', key: 'profile-save' });
    } finally {
      setSavingProfile(false);
    }
  };

  const savePassword = async (event: FormEvent) => {
    event.preventDefault();
    setPasswordError('');
    if (newPassword !== confirmPassword) {
      setPasswordError('New password and confirmation do not match');
      return;
    }
    setSavingPassword(true);
    try {
      const result = await changePassword(currentPassword, newPassword);
      if (!result.ok) {
        notify.error(result.error, { key: 'password-change' });
        return;
      }
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      notify.success('Password updated.', { key: 'password-change' });
    } catch (cause) {
      notify.error(cause, { fallback: 'Could not update the password', key: 'password-change' });
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
            { href: '/settings/skills', label: 'Skills' },
            { href: '/settings/usage', label: 'Usage' },
          ]}
        />

        <StorageUsage />

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
            <div className="space-y-8">
              <p className="text-[13px] text-[var(--studio-muted)]">
                Upload an image for your avatar. Existing data URLs still display.
              </p>
              <label className="inline-flex cursor-pointer items-center rounded-full border border-[var(--studio-line-strong)] px-12 py-6 text-[13px] font-medium text-[var(--studio-fg)] hover:bg-[var(--studio-surface-hover)]">
                <input
                  type="file"
                  accept="image/*"
                  className="sr-only"
                  disabled={uploadingAvatar}
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (!file) return;
                    setUploadingAvatar(true);
                    try {
                      const formData = new FormData();
                      formData.set('file', file);
                      const result = await uploadAvatar(formData);
                      if (!result.ok) {
                        notify.error(result.error, { key: 'avatar-upload' });
                        return;
                      }
                      await update({
                        user: { name: result.data.name, avatarUrl: result.data.avatarUrl },
                      });
                      setAvatarUrl(result.data.avatarUrl || '');
                      setPreviewBroken(false);
                      notify.success('Avatar uploaded.', { key: 'avatar-upload' });
                    } catch (cause) {
                      notify.error(cause, {
                        fallback: 'Could not upload the image',
                        key: 'avatar-upload',
                      });
                    } finally {
                      setUploadingAvatar(false);
                    }
                  }}
                />
                {uploadingAvatar ? 'Uploading…' : 'Upload image'}
              </label>
            </div>
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
          <StudioButton type="submit" variant="ghost" disabled={savingPassword}>
            {savingPassword ? 'Updating…' : 'Update password'}
          </StudioButton>
        </form>

        <section className="mt-40 space-y-12">
          <h2 className="text-[18px] font-medium text-[var(--studio-fg)]">Your data</h2>
          <p className="text-[13px] leading-5 text-[var(--studio-muted)]">
            Ask an admin for a copy of your account data or to delete the account. This emails
            administrators — nothing is deleted automatically.
          </p>
          <div className="flex flex-wrap gap-8">
            {(['export', 'deletion'] as const).map((kind) => (
              <StudioButton
                key={kind}
                type="button"
                variant="ghost"
                disabled={dataRequesting}
                onClick={async () => {
                  setDataRequesting(true);
                  try {
                    const response = await fetch('/api/legal/data-request', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ kind }),
                    });
                    const data = await response.json().catch(() => ({}));
                    if (!response.ok) {
                      notify.error(String(data.error || 'Could not send request'), {
                        key: 'data-request',
                      });
                      return;
                    }
                    notify.success(
                      kind === 'deletion'
                        ? 'Deletion request sent to administrators.'
                        : 'Export request sent to administrators.',
                      { key: 'data-request' },
                    );
                  } catch (cause) {
                    notify.error(cause, {
                      fallback: 'Could not send request',
                      key: 'data-request',
                    });
                  } finally {
                    setDataRequesting(false);
                  }
                }}
              >
                {dataRequesting
                  ? 'Sending…'
                  : kind === 'deletion'
                    ? 'Request account deletion'
                    : 'Request data export or deletion'}
              </StudioButton>
            ))}
          </div>
        </section>
      </main>
    </StudioShell>
  );
}
