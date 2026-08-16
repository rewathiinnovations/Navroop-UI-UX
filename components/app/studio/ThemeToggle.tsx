"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { cn } from "@/utils/cn";

export default function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const isDark = mounted && resolvedTheme === "dark";

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      aria-pressed={isDark}
      className={cn(
        "inline-flex size-[44px] shrink-0 items-center justify-center rounded-full",
        "text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100",
        "dark:text-zinc-400 dark:hover:text-zinc-100 dark:hover:bg-zinc-800",
        "border border-zinc-200 dark:border-zinc-700",
        "transition-colors duration-200 ease-out cursor-pointer",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:focus-visible:ring-[#ff6b8a]",
        className,
      )}
    >
      {!mounted ? (
        <span className="size-18" aria-hidden />
      ) : isDark ? (
        <Sun className="size-18" aria-hidden />
      ) : (
        <Moon className="size-18" aria-hidden />
      )}
    </button>
  );
}
