"use client";

import { useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import AuthModal, { type AuthMode } from "@/components/app/auth/AuthModal";
import PromptHero, { type PromptHeroHandle } from "@/components/dashboard/PromptHero";
import StudioButton from "@/components/app/studio/StudioButton";
import StudioLogo from "@/components/app/studio/StudioLogo";
import ThemeToggle from "@/components/app/studio/ThemeToggle";
import "@/components/app/studio/studio.css";
import { PENDING_PROMPT_KEY, clearDraftStorage } from "@/hooks/useDraftStorage";
import { createProjectFromPrompt } from "@/lib/projects/start-from-prompt";
import type { StackId } from "@/lib/stacks";

type HomeLandingProps = {
  initialAuth?: AuthMode | null;
  nextPath?: string | null;
};

export default function HomeLanding({
  initialAuth = null,
  nextPath = null,
}: HomeLandingProps) {
  const router = useRouter();
  const { data: session } = useSession();
  const heroRef = useRef<PromptHeroHandle>(null);
  const [authOpen, setAuthOpen] = useState(Boolean(initialAuth));
  const [authMode, setAuthMode] = useState<AuthMode>(initialAuth || "signup");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!initialAuth) return;
    setAuthMode(initialAuth);
    setAuthOpen(true);
  }, [initialAuth]);

  const openAuth = (mode: AuthMode) => {
    heroRef.current?.flush();
    setError("");
    setAuthMode(mode);
    setAuthOpen(true);
  };

  const onSubmit = async (value: string, stack: StackId) => {
    setError("");
    if (!session?.user) {
      openAuth("signup");
      return;
    }

    try {
      const created = await createProjectFromPrompt(value, stack);
      if (!created.ok) {
        setError(created.error);
        return;
      }
      clearDraftStorage(PENDING_PROMPT_KEY);
      router.push(`/project/${created.project.id}`);
    } catch {
      setError("Could not create project");
    }
  };

  return (
    <div className="studio-shell relative flex h-dvh flex-col overflow-hidden">
      <div className="studio-glow" aria-hidden />

      <header className="relative z-10 shrink-0">
        <div className="mx-auto flex h-[64px] max-w-[1120px] items-center justify-between px-20">
          <StudioLogo href="/" />
          <div className="flex items-center gap-8">
            <ThemeToggle />
            <button
              type="button"
              onClick={() => openAuth("login")}
              className="inline-flex min-h-[44px] items-center px-12 text-[14px] text-[var(--studio-muted)] hover:text-[var(--studio-fg)] transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)] rounded-full"
            >
              Log in
            </button>
            <StudioButton variant="primary" onClick={() => openAuth("signup")}>
              Sign up
            </StudioButton>
          </div>
        </div>
      </header>

      <main className="relative z-10 flex min-h-0 flex-1 flex-col items-center justify-center px-20">
        <div className="w-full max-w-[720px] -translate-y-12">
          <PromptHero
            ref={heroRef}
            greeting="Describe it. We'll build the site."
            onSubmit={onSubmit}
            description={
              <p className="mx-auto mt-12 max-w-[520px] text-center text-[16px] leading-6 text-[var(--studio-muted)]">
                A sentence or a URL is enough. Navroop turns it into a working website you can keep editing in the studio.
              </p>
            }
          />
          {error && (
            <p className="mt-12 text-center text-[14px] text-[var(--studio-danger)]" role="alert">
              {error}
            </p>
          )}
        </div>
      </main>

      <footer className="relative z-10 shrink-0 py-16 text-center text-[13px] text-[var(--studio-faint)]">
        © 2026 Navroop
      </footer>

      <AuthModal
        open={authOpen}
        mode={authMode}
        onModeChange={setAuthMode}
        onClose={() => setAuthOpen(false)}
        nextPath={nextPath}
      />
    </div>
  );
}
