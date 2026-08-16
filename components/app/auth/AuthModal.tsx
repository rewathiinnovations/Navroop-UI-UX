"use client";

import { FormEvent, useEffect, useId, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { CircleAlert, Shield, User, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/shadcn/dialog";
import StudioButton from "@/components/app/studio/StudioButton";
import StudioField from "@/components/app/studio/StudioField";
import { isDevQuickLoginEnabled } from "@/lib/dev-quick-login";
import { validateEmail } from "@/lib/email";
import { safeNextPath } from "@/lib/auth/public-login";
import { createProjectFromPrompt } from "@/lib/projects/start-from-prompt";
import {
  PENDING_PROMPT_KEY,
  clearDraftStorage,
  readDraftStorage,
} from "@/hooks/useDraftStorage";

export type AuthMode = "login" | "signup";

type AuthModalProps = {
  open: boolean;
  mode: AuthMode;
  onModeChange: (mode: AuthMode) => void;
  onClose: () => void;
  nextPath?: string | null;
};

const DUPLICATE_EMAIL =
  "An account with this email already exists — log in instead";

export default function AuthModal({
  open,
  mode,
  onModeChange,
  onClose,
  nextPath,
}: AuthModalProps) {
  const router = useRouter();
  const titleId = useId();
  const showQuickLogin = isDevQuickLoginEnabled();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [duplicateEmail, setDuplicateEmail] = useState(false);
  const [loading, setLoading] = useState(false);
  const [quickRole, setQuickRole] = useState<"admin" | "member" | null>(null);

  useEffect(() => {
    if (!open) return;
    setError("");
    setDuplicateEmail(false);
    setPassword("");
    setLoading(false);
    setQuickRole(null);
  }, [open, mode]);

  const finishAuthenticated = async () => {
    const draft = readDraftStorage(PENDING_PROMPT_KEY);
    const prompt = draft?.text.trim() || "";
    if (draft && prompt) {
      const created = await createProjectFromPrompt(prompt, draft.stack);
      if (created.ok) {
        clearDraftStorage(PENDING_PROMPT_KEY);
        onClose();
        router.push(`/project/${created.project.id}`);
        router.refresh();
        return;
      }
      onClose();
      router.push("/dashboard");
      router.refresh();
      return;
    }

    onClose();
    router.push(safeNextPath(nextPath) || "/dashboard");
    router.refresh();
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setDuplicateEmail(false);

    const trimmedName = name.trim();
    const trimmedEmail = email.trim().toLowerCase();

    if (mode === "signup" && !trimmedName) {
      setError("Name is required");
      return;
    }
    if (!validateEmail(trimmedEmail)) {
      setError("Enter a valid email address");
      return;
    }
    if (mode === "signup" && password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (!password) {
      setError("Password is required");
      return;
    }

    setLoading(true);
    try {
      if (mode === "signup") {
        const response = await fetch("/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: trimmedName,
            email: trimmedEmail,
            password,
          }),
        });
        const data = await response.json().catch(() => ({}));
        if (response.status === 409 || data.code === "EMAIL_EXISTS") {
          setDuplicateEmail(true);
          setError(DUPLICATE_EMAIL);
          return;
        }
        if (!response.ok) {
          setError(data.error || "Could not create account");
          return;
        }
      }

      const result = await signIn("credentials", {
        email: trimmedEmail,
        password,
        redirect: false,
      });
      if (result?.error) {
        setError(mode === "login" ? "Invalid email or password" : "Could not sign in");
        return;
      }
      await finishAuthenticated();
    } catch {
      setError(mode === "login" ? "Could not sign in" : "Could not create account");
    } finally {
      setLoading(false);
    }
  };

  const onQuickLogin = async (role: "admin" | "member") => {
    setError("");
    setDuplicateEmail(false);
    setQuickRole(role);
    setLoading(true);
    try {
      const result = await signIn("credentials", {
        devRole: role,
        redirect: false,
      });
      if (result?.error) {
        setError("Could not sign in");
        return;
      }
      await finishAuthenticated();
    } catch {
      setError("Could not sign in");
    } finally {
      setLoading(false);
      setQuickRole(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent
        hideCloseButton
        aria-labelledby={titleId}
        className="studio-shell max-h-[min(90vh,640px)] max-w-[400px] overflow-y-auto rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] p-24 text-left shadow-[0_16px_40px_rgba(24,24,27,0.18)] sm:rounded-12"
      >
        <div className="mb-16 flex items-start justify-between gap-12">
          <div>
            <DialogTitle
              id={titleId}
              className="text-[22px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]"
            >
              {mode === "signup" ? "Create your account" : "Welcome back"}
            </DialogTitle>
            <DialogDescription className="mt-6 text-[14px] leading-5 text-[var(--studio-muted)]">
              {mode === "signup"
                ? "Save your prompt and start building in the studio."
                : "Sign in to open your projects and keep building."}
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

        <form onSubmit={onSubmit} className="space-y-14">
          {mode === "signup" && (
            <StudioField
              id="auth-name"
              label="Name"
              autoComplete="name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Your name"
            />
          )}
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
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            required
            minLength={mode === "signup" ? 8 : undefined}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={mode === "signup" ? "At least 8 characters" : "Your password"}
          />

          {error && (
            <p
              className="flex items-start gap-8 text-[13px] text-[var(--studio-danger)]"
              role="alert"
            >
              <CircleAlert className="size-16 mt-2 shrink-0" aria-hidden />
              <span>
                {error}
                {duplicateEmail && (
                  <>
                    {" "}
                    <button
                      type="button"
                      onClick={() => onModeChange("login")}
                      className="font-medium underline underline-offset-2 cursor-pointer"
                    >
                      Log in
                    </button>
                  </>
                )}
              </span>
            </p>
          )}

          <StudioButton type="submit" variant="inverted" className="w-full" disabled={loading}>
            {loading && !quickRole
              ? mode === "signup"
                ? "Creating account…"
                : "Signing in…"
              : mode === "signup"
                ? "Sign up"
                : "Log in"}
          </StudioButton>
        </form>

        {mode === "login" && showQuickLogin && (
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
              onClick={() => void onQuickLogin("admin")}
            >
              <Shield className="size-16" aria-hidden />
              {quickRole === "admin" ? "Signing in…" : "Login as Admin"}
            </StudioButton>
            <StudioButton
              type="button"
              variant="ghost"
              className="w-full"
              disabled={loading}
              onClick={() => void onQuickLogin("member")}
            >
              <User className="size-16" aria-hidden />
              {quickRole === "member" ? "Signing in…" : "Login as Member"}
            </StudioButton>
          </div>
        )}

        <p className="mt-18 text-center text-[13px] text-[var(--studio-muted)]">
          {mode === "signup" ? "Already have an account?" : "New to Navroop?"}{" "}
          <button
            type="button"
            onClick={() => onModeChange(mode === "signup" ? "login" : "signup")}
            className="font-medium text-[var(--studio-fg)] underline underline-offset-2 cursor-pointer"
          >
            {mode === "signup" ? "Log in" : "Sign up"}
          </button>
        </p>
      </DialogContent>
    </Dialog>
  );
}
