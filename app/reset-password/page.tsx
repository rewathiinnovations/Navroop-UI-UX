import StudioButton from "@/components/app/studio/StudioButton";
import StudioLogo from "@/components/app/studio/StudioLogo";
import ThemeToggle from "@/components/app/studio/ThemeToggle";
import "@/components/app/studio/studio.css";
import { loginModalHref } from "@/lib/auth/public-login";
import { peekResetToken } from "@/lib/password-reset/service";
import ResetPasswordForm from "./ResetPasswordForm";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : "";
  const peeked = token ? await peekResetToken(token) : { ok: false as const };

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
                Set a new password
              </h1>
              <p className="mt-6 mb-18 text-[14px] leading-5 text-[var(--studio-muted)]">
                Choose a new password for your Navroop account.
              </p>
              <ResetPasswordForm token={token} />
            </>
          ) : (
            <>
              <h1 className="text-[22px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">
                This link has expired
              </h1>
              <p className="mt-6 mb-18 text-[14px] leading-5 text-[var(--studio-muted)]">
                Request a new reset link — the previous one can no longer be used.
              </p>
              <StudioButton href={`${loginModalHref()}&forgot=1`} variant="inverted" className="w-full">
                Request a new link
              </StudioButton>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
