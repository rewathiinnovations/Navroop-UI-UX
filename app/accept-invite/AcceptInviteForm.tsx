'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CircleAlert, Eye, EyeOff } from 'lucide-react';
import StudioButton from '@/components/app/studio/StudioButton';
import StudioField from '@/components/app/studio/StudioField';
import { loginModalHref } from '@/lib/auth/public-login';
import { passwordStrengthHint } from '@/lib/auth/password-hint';

/**
 * The invitee's half of F-351: they choose the password, so the admin never has one to
 * relay. Same two fields, same show/hide, same failure copy as `ResetPasswordForm` — the
 * only difference is where it posts and where it sends you afterwards.
 */
export default function AcceptInviteForm({ token }: { token: string }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch('/api/auth/accept-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) {
        setError(data.error || 'Could not accept the invite');
        return;
      }
      // Nothing on the sign-in modal reads a status flag, so none is invented here.
      router.push(loginModalHref());
    } catch {
      setError('Could not accept the invite');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-14">
      <div className="relative">
        <StudioField
          id="accept-invite-password"
          label="Password"
          type={showPassword ? 'text' : 'password'}
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="At least 8 characters"
        />
        <button
          type="button"
          onClick={() => setShowPassword((value) => !value)}
          className="absolute right-16 top-[38px] inline-flex size-[28px] items-center justify-center text-[var(--studio-muted)] hover:text-[var(--studio-fg)] cursor-pointer"
          aria-label={showPassword ? 'Hide password' : 'Show password'}
        >
          {showPassword ? <EyeOff className="size-16" /> : <Eye className="size-16" />}
        </button>
        <p className="mt-6 text-[12px] text-[var(--studio-muted)]">
          {passwordStrengthHint(password)}
        </p>
      </div>

      <div className="relative">
        <StudioField
          id="accept-invite-confirm"
          label="Confirm password"
          type={showConfirm ? 'text' : 'password'}
          autoComplete="new-password"
          required
          minLength={8}
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          placeholder="Enter the same password again"
        />
        <button
          type="button"
          onClick={() => setShowConfirm((value) => !value)}
          className="absolute right-16 top-[38px] inline-flex size-[28px] items-center justify-center text-[var(--studio-muted)] hover:text-[var(--studio-fg)] cursor-pointer"
          aria-label={showConfirm ? 'Hide password' : 'Show password'}
        >
          {showConfirm ? <EyeOff className="size-16" /> : <Eye className="size-16" />}
        </button>
      </div>

      {error && (
        <p className="flex items-start gap-8 text-[13px] text-[var(--studio-danger)]" role="alert">
          <CircleAlert className="size-16 mt-2 shrink-0" aria-hidden />
          <span>{error}</span>
        </p>
      )}

      <StudioButton type="submit" variant="inverted" className="w-full" disabled={loading}>
        {loading ? 'Setting password…' : 'Set password and continue'}
      </StudioButton>
    </form>
  );
}
