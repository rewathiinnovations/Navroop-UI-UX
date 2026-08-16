"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { LogOut } from "lucide-react";
import ButtonUI from "@/components/ui/shadcn/button";
import StudioButton from "@/components/app/studio/StudioButton";

type User = { id: string; email: string; name: string };

export default function AuthNav({
  compact = false,
  tone = "light",
}: {
  compact?: boolean;
  tone?: "light" | "studio";
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const onDashboard = pathname === "/dashboard";

  useEffect(() => {
    fetch("/api/auth/me")
      .then((res) => (res.ok ? res.json() : { user: null }))
      .then((data) => setUser(data.user))
      .catch(() => setUser(null))
      .finally(() => setReady(true));
  }, []);

  const logout = async () => {
    await signOut({ redirect: false });
    setUser(null);
    router.push("/");
    router.refresh();
  };

  if (tone === "studio") {
    if (!ready) {
      return <div className="h-44 w-160 rounded-full bg-[var(--studio-skeleton)] animate-pulse" />;
    }

    if (!user) {
      return (
        <div className="flex items-center gap-8">
          <Link
            href="/?auth=login"
            className="inline-flex items-center justify-center min-h-[44px] px-14 rounded-full text-[14px] text-[var(--studio-muted)] hover:text-[var(--studio-fg)] transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
          >
            Sign in
          </Link>
          {!compact && (
            <StudioButton variant="primary" href="/?auth=signup">
              Get started
            </StudioButton>
          )}
        </div>
      );
    }

    return (
      <div className="flex items-center gap-4">
        {!onDashboard && (
          <Link
            href="/dashboard"
            className="inline-flex items-center justify-center min-h-[44px] px-14 rounded-full text-[14px] text-[var(--studio-muted)] hover:text-[var(--studio-fg)] transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
          >
            Projects
          </Link>
        )}
        <span className="hidden sm:inline text-[13px] text-[var(--studio-muted)] px-8">
          {user.name.split(" ")[0]}
        </span>
        <StudioButton variant="ghost" onClick={logout} aria-label="Sign out">
          <LogOut className="size-16" aria-hidden />
          Sign out
        </StudioButton>
      </div>
    );
  }

  if (!ready) {
    return <div className="h-32 w-72 rounded-8 bg-black-alpha-4 dark:bg-zinc-800 animate-pulse" />;
  }

  if (!user) {
    return (
      <div className="flex items-center gap-8">
        <Link href="/?auth=login" className="contents">
          <ButtonUI variant="tertiary" className="dark:text-zinc-100">Sign in</ButtonUI>
        </Link>
        {!compact && (
          <Link href="/?auth=signup" className="contents">
            <ButtonUI variant="primary">Get started</ButtonUI>
          </Link>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-8">
      <Link href="/dashboard" className="contents">
        <ButtonUI variant="tertiary" className="dark:text-zinc-100">Projects</ButtonUI>
      </Link>
      <button
        type="button"
        onClick={logout}
        className="h-32 px-10 text-label-small text-black-alpha-64 hover:text-accent-black dark:text-zinc-400 dark:hover:text-zinc-100 transition-colors duration-200 cursor-pointer rounded-8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-heat-100"
      >
        {user.name.split(" ")[0]} · Sign out
      </button>
    </div>
  );
}
