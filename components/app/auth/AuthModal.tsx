'use client';

import { FormEvent, useEffect, useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { CircleAlert, Shield, User, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/shadcn/dialog';
import StudioButton from '@/components/app/studio/StudioButton';
import StudioField from '@/components/app/studio/StudioField';
import { isDevQuickLoginEnabled } from '@/lib/dev-quick-login';
import { validateEmail } from '@/lib/email';
import { safeNextPath } from '@/lib/auth/public-login';
import { createProjectFromPrompt } from '@/lib/projects/start-from-prompt';
import { notify } from '@/lib/notify';
import { cn } from '@/utils/cn';
import { PENDING_PROMPT_KEY, clearDraftStorage } from '@/hooks/useDraftStorage';
import type { PendingPrompt } from '@/lib/projects/signed-out-submit';

/**
 * `'signup'` no longer means "show a registration form" — it means "explain how access
 * works". Navroop is invite-only: an admin creates the account through
 * `POST /api/admin/invite`, which mails a single-use link the invitee redeems at
 * `/accept-invite` to set their own password (F-351), and both
 * `POST /api/auth/register` and `POST /api/auth/signup` answer 403 without touching the
 * database. This modal used to POST to `/api/auth/register`, which meant the only
 * possible outcome of filling the form in was an error — including for someone who had
 * just been invited. The mode is kept in the union because the entry points that open it
 * (`?auth=signup`, the landing page buttons) live outside this file; what changed is that
 * it now renders copy instead of inputs.
 *
 * The panel asks for no email, so it cannot confirm or deny that a given address was
 * invited.
 */
export type AuthMode = 'login' | 'signup';

/**
 * One sentence for every 2xx `/api/auth/forgot-password` can return.
 *
 * The route answers 200 with the same envelope whether the address exists, does
 * not exist, or was dropped by the hourly limiter (`EMAIL_LIMIT` 3, `IP_LIMIT`
 * 10) — deliberately, so nothing distinguishes a member from a stranger. The old
 * copy turned that uniform 200 into "a reset link is on its way", which is a
 * promise the response cannot support for a throttled request. This states what
 * is true in every case, and being constant it still reveals nothing.
 */
const FORGOT_SUBMITTED_MESSAGE =
  'Request received. If that address has an account and has not asked for a reset in the last hour, a link is on its way.';
const AUTH_LINK =
  'inline-flex min-h-[44px] items-center rounded-8 text-[13px] font-medium text-[var(--studio-fg)] underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]';

type AuthModalProps = {
  open: boolean;
  mode: AuthMode;
  onModeChange: (mode: AuthMode) => void;
  onClose: () => void;
  nextPath?: string | null;
  initialForgot?: boolean;
  resetSuccess?: boolean;
  /** Consumes the pending submit, if any: it must not survive being acted on. */
  takePendingPrompt?: () => PendingPrompt | null;
};

export default function AuthModal({
  open,
  mode,
  onModeChange,
  onClose,
  nextPath,
  initialForgot = false,
  resetSuccess = false,
  takePendingPrompt,
}: AuthModalProps) {
  const router = useRouter();
  const showQuickLogin = isDevQuickLoginEnabled();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [quickRole, setQuickRole] = useState<'admin' | 'member' | null>(null);
  const [panel, setPanel] = useState<'auth' | 'forgot' | 'forgot-sent'>(
    initialForgot ? 'forgot' : 'auth',
  );
  const [info, setInfo] = useState(resetSuccess ? 'Password updated — sign in' : '');

  useEffect(() => {
    if (!open) {
      setEmail('');
      setPassword('');
      return;
    }
    setError('');
    setPassword('');
    setLoading(false);
    setQuickRole(null);
    setPanel(initialForgot ? 'forgot' : 'auth');
    setInfo(resetSuccess ? 'Password updated — sign in' : '');
  }, [open, mode, initialForgot, resetSuccess]);

  const finishAuthenticated = async (welcome: string) => {
    // Toasted rather than shown in the dialog: the dialog is about to close and
    // the user lands on a different page.
    notify.success(welcome, { key: 'auth' });

    // Taken, not read — and taken before the project is created, so it is spent either way.
    //
    // This used to read `PENDING_PROMPT_KEY` out of localStorage and treat any text there as
    // an instruction to create a project. That key is the hero's autosave: an abandoned
    // half-sentence in it turned the *next* sign-in — including the one at the end of a
    // password reset, which ignored `nextPath` entirely — into a new project with a plan job
    // running against it, and it was retried on every sign-in until one happened to succeed.
    // Pressing submit on the signed-out hero is the only thing that is consent to spend
    // credits, and that is what fills this in (in memory, so a second tab has nothing to
    // clobber and nothing to inherit).
    const pending = takePendingPrompt?.() ?? null;
    if (pending) {
      const created = await createProjectFromPrompt(
        pending.text,
        pending.stack,
        pending.designDirection,
        pending.importMode,
      );
      if (created.ok) {
        clearDraftStorage(PENDING_PROMPT_KEY);
        onClose();
        router.push(`/project/${created.project.id}`);
        router.refresh();
        return;
      }
      // The saved prompt could not be turned into a project — say so rather
      // than dropping the user on the dashboard with no explanation. The hero draft is
      // deliberately left alone so the text is still there to resubmit.
      notify.error(created.error, {
        fallback: 'Signed in, but that prompt could not be started.',
        key: 'auth-draft',
      });
      onClose();
      router.push('/dashboard');
      router.refresh();
      return;
    }

    onClose();
    router.push(safeNextPath(nextPath) || '/dashboard');
    router.refresh();
  };

  // Sign-in only. There is no account-creation branch here because there is no endpoint
  // that would accept one.
  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');

    const trimmedEmail = email.trim().toLowerCase();

    if (!validateEmail(trimmedEmail)) {
      setError('Enter a valid email address');
      return;
    }
    if (!password) {
      setError('Password is required');
      return;
    }

    setLoading(true);
    try {
      const result = await signIn('credentials', {
        email: trimmedEmail,
        password,
        redirect: false,
      });
      if (result?.error) {
        setError('Invalid email or password');
        return;
      }
      await finishAuthenticated('Signed in.');
    } catch {
      setError('Could not sign in');
    } finally {
      setLoading(false);
    }
  };

  const onForgotSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    const trimmedEmail = email.trim().toLowerCase();
    if (!validateEmail(trimmedEmail)) {
      setError('Enter a valid email address');
      return;
    }
    setLoading(true);
    try {
      const response = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmedEmail }),
      });
      // The catch used to be empty and the "on its way" line unconditional, so a
      // 500 or a dropped connection read exactly like a queued email and the
      // person waited for something that was never sent. Saying the *request*
      // failed reveals nothing about whether the address has an account.
      if (!response.ok) {
        setError('Could not send the reset request. Please try again.');
        return;
      }
      setPanel('forgot-sent');
      // Wording that holds for every 2xx the route can return, including a
      // request its hourly limiter dropped. It is the same sentence for every
      // address, so it still says nothing about who has an account.
      notify.info(FORGOT_SUBMITTED_MESSAGE, { key: 'auth-forgot' });
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const onQuickLogin = async (role: 'admin' | 'member') => {
    setError('');
    setQuickRole(role);
    setLoading(true);
    try {
      const result = await signIn('credentials', {
        devRole: role,
        redirect: false,
      });
      if (result?.error) {
        setError('Could not sign in');
        return;
      }
      await finishAuthenticated(`Signed in as ${role}.`);
    } catch {
      setError('Could not sign in');
    } finally {
      setLoading(false);
      setQuickRole(null);
    }
  };

  const inviteOnly = panel === 'auth' && mode === 'signup';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        hideCloseButton
        className="studio-shell max-h-[min(90vh,640px)] max-w-[400px] overflow-y-auto rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] p-24 text-left shadow-[var(--studio-shadow-pop)] sm:rounded-12"
      >
        <div className="mb-16 flex items-start justify-between gap-12">
          <div>
            <DialogTitle className="text-[24px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">
              {panel === 'forgot-sent'
                ? 'Check your email'
                : panel !== 'auth'
                  ? 'Password reset'
                  : inviteOnly
                    ? 'Navroop is invite only'
                    : 'Welcome back'}
            </DialogTitle>
            <DialogDescription className="mt-8 text-[14px] leading-6 text-[var(--studio-muted)]">
              {panel === 'forgot-sent'
                ? 'If this email is registered, a reset link is on its way. Check inbox and spam.'
                : panel !== 'auth'
                  ? "We'll send a reset link to the registered email."
                  : inviteOnly
                    ? 'Accounts are created by an admin, so there is no sign-up form.'
                    : 'Sign in to open your projects and keep building.'}
            </DialogDescription>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="inline-flex size-[44px] shrink-0 items-center justify-center rounded-10 text-[var(--studio-muted)] hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)] transition-colors duration-200 cursor-pointer"
          >
            <X className="size-18" />
          </button>
        </div>

        {panel === 'forgot-sent' ? (
          <div className="space-y-14">
            <p className="text-[14px] leading-6 text-[var(--studio-fg)]" role="status">
              {FORGOT_SUBMITTED_MESSAGE} Check inbox and spam.
            </p>
            <StudioButton
              type="button"
              variant="inverted"
              className="w-full"
              onClick={() => {
                setPanel('auth');
                setError('');
              }}
            >
              Back to sign in
            </StudioButton>
          </div>
        ) : panel !== 'auth' ? (
          <form onSubmit={onForgotSubmit} className="space-y-16">
            <StudioField
              id="forgot-email"
              label="Email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@studio.com"
            />
            {error && (
              <p
                className="flex items-start gap-8 text-[13px] text-[var(--studio-danger)]"
                role="alert"
              >
                <CircleAlert className="size-16 mt-2 shrink-0" aria-hidden />
                <span>{error}</span>
              </p>
            )}
            <StudioButton type="submit" variant="inverted" className="w-full" disabled={loading}>
              {loading ? 'Sending…' : 'Send reset link'}
            </StudioButton>
            <button
              type="button"
              onClick={() => {
                setPanel('auth');
                setError('');
              }}
              className={cn(AUTH_LINK, 'w-full justify-center')}
            >
              Back to sign in
            </button>
          </form>
        ) : inviteOnly ? (
          // No inputs on purpose: every field here would feed an endpoint that returns
          // 403 to everyone. Ask an admin, then sign in.
          <div className="space-y-14">
            <p className="text-[13px] leading-5 text-[var(--studio-fg)]">
              An admin creates your account from the Team page, and you get an email with a
              single-use link. Open it to choose your own password — nothing is passed on by hand,
              and no temporary password exists.
            </p>
            <p className="text-[13px] leading-5 text-[var(--studio-muted)]">
              Already set your password? Sign in — anything you typed on the landing page is kept
              and starts building once you are in.
            </p>
            <StudioButton
              type="button"
              variant="inverted"
              className="w-full"
              onClick={() => onModeChange('login')}
            >
              Go to sign in
            </StudioButton>
            <p className="text-[13px] leading-5 text-[var(--studio-muted)]">
              Read the{' '}
              <a
                href="/terms"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                Terms
              </a>{' '}
              and{' '}
              <a
                href="/privacy"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                Privacy Policy
              </a>{' '}
              — using Navroop means you accept both.
            </p>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-16">
            <StudioField
              id="auth-email"
              label="Email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@studio.com"
            />
            <StudioField
              id="auth-password"
              label="Password"
              type="password"
              revealable
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Your password"
            />
            <button
              type="button"
              onClick={() => {
                setPanel('forgot');
                setError('');
              }}
              className={AUTH_LINK}
            >
              Forgot password?
            </button>
            {info && (
              <p className="text-[13px] leading-5 text-[var(--studio-fg)]" role="status">
                {info}
              </p>
            )}

            {error && (
              <p
                className="flex items-start gap-8 text-[13px] text-[var(--studio-danger)]"
                role="alert"
              >
                <CircleAlert className="size-16 mt-2 shrink-0" aria-hidden />
                <span>{error}</span>
              </p>
            )}

            <StudioButton type="submit" variant="inverted" className="w-full" disabled={loading}>
              {loading && !quickRole ? 'Signing in…' : 'Log in'}
            </StudioButton>
          </form>
        )}

        {panel === 'auth' && mode === 'login' && showQuickLogin && (
          <div className="mt-16 space-y-8">
            <div className="flex items-center gap-12">
              <div className="h-px flex-1 bg-[var(--studio-line)]" />
              <p className="text-[12px] text-[var(--studio-muted)]">Local only</p>
              <div className="h-px flex-1 bg-[var(--studio-line)]" />
            </div>
            <StudioButton
              type="button"
              variant="ghost"
              className="w-full"
              disabled={loading}
              onClick={() => void onQuickLogin('admin')}
            >
              <Shield className="size-16" aria-hidden />
              {quickRole === 'admin' ? 'Signing in…' : 'Login as Admin'}
            </StudioButton>
            <StudioButton
              type="button"
              variant="ghost"
              className="w-full"
              disabled={loading}
              onClick={() => void onQuickLogin('member')}
            >
              <User className="size-16" aria-hidden />
              {quickRole === 'member' ? 'Signing in…' : 'Login as Member'}
            </StudioButton>
          </div>
        )}

        {panel === 'auth' && !inviteOnly && (
          <p className="mt-18 text-center text-[13px] text-[var(--studio-muted)]">
            New to Navroop?{' '}
            <button
              type="button"
              onClick={() => onModeChange('signup')}
              className={AUTH_LINK}
            >
              How to get access
            </button>
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
