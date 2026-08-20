import StudioButton from '@/components/app/studio/StudioButton';
import StudioLogo from '@/components/app/studio/StudioLogo';
import ThemeToggle from '@/components/app/studio/ThemeToggle';
import '@/components/app/studio/studio.css';
import { loginModalHref } from '@/lib/auth/public-login';
import { peekInviteToken } from '@/lib/invites/service';
import AcceptInviteForm from './AcceptInviteForm';

/**
 * Where an invite link lands (F-351). Deliberately the same shell and the same shape as
 * `/reset-password`: an invite is a first password, and a reset is a replacement one.
 *
 * The peek here decides which of the two panels to render. It is not the gate — the gate is
 * the conditional claim inside `acceptInviteWithToken`, which is what makes the link single
 * use even if two tabs are open.
 */
export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const params = await searchParams;
  const token = typeof params.token === 'string' ? params.token : '';
  const peeked = token ? await peekInviteToken(token) : { ok: false as const };

  return (
    <div className="studio-shell relative flex min-h-dvh flex-col">
      <div className="studio-glow" aria-hidden />
      <header className="relative z-10 shrink-0">
        <div className="mx-auto flex h-[64px] max-w-[1120px] items-center justify-between px-20">
          <StudioLogo href="/" />
          <ThemeToggle />
        </div>
      </header>

      <main className="relative z-10 flex flex-1 items-center justify-center px-20 py-40">
        <div className="w-full max-w-[400px] rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] p-24 shadow-[0_16px_40px_rgba(24,24,27,0.12)]">
          {peeked.ok ? (
            <>
              <h1 className="text-[22px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">
                Choose a password
              </h1>
              <p className="mt-6 mb-18 text-[14px] leading-5 text-[var(--studio-muted)]">
                Your Navroop account is ready for{' '}
                <span className="font-medium text-[var(--studio-fg)]">{peeked.email}</span>. Set a
                password to finish signing up.
              </p>
              <AcceptInviteForm token={token} />
            </>
          ) : (
            <>
              <h1 className="text-[22px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">
                This invite is no longer valid
              </h1>
              <p className="mt-6 mb-18 text-[14px] leading-5 text-[var(--studio-muted)]">
                The link has expired, or it has already been used. Ask an admin to send a new invite
                — or sign in if you have already set a password.
              </p>
              <StudioButton href={loginModalHref()} variant="inverted" className="w-full">
                Go to sign in
              </StudioButton>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
