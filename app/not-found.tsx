import Link from 'next/link';
import StudioShell from '@/components/app/studio/StudioShell';

/**
 * The 404 for a URL that matches no segment at all (F-445).
 *
 * There was none, so an unmatched address rendered the framework's default: black Helvetica
 * on white, no logo, no theme, no link anywhere. `StudioShell variant="auth"` is the same
 * centred frame the sign-in and reset pages use — the right one here, because a visitor on a
 * broken link may not be signed in.
 */
export default function NotFound() {
  return (
    <StudioShell variant="auth" logoHref="/">
      <div className="w-full max-w-[420px] text-center">
        <h1 className="mb-12 text-[24px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">
          Page not found
        </h1>
        <p className="text-[14px] text-[var(--studio-muted)]">
          The address you followed does not exist.
        </p>
        <div className="mt-24 flex flex-wrap items-center justify-center gap-14">
          <Link
            href="/dashboard"
            className="inline-flex h-36 items-center rounded-full bg-[var(--studio-fg)] px-14 text-[13px] text-[var(--studio-bg)]"
          >
            Back to dashboard
          </Link>
          <Link href="/" className="text-[13px] text-[var(--studio-accent)] hover:underline">
            Go to the home page
          </Link>
        </div>
      </div>
    </StudioShell>
  );
}
