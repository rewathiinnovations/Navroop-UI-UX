'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { cn } from '@/utils/cn';

export default function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const isDark = mounted && resolvedTheme === 'dark';

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      aria-pressed={isDark}
      className={cn(
        'inline-flex size-[44px] shrink-0 items-center justify-center rounded-full',
        // Every host of this button is a `.studio-shell`, so the studio tokens
        // are in scope. The zinc/`#ff6b8a` literals it used to carry duplicated
        // `--studio-muted`/`--studio-line-strong`/`--studio-ring` by hand and
        // drifted from them.
        'text-[var(--studio-muted)] hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)]',
        'border border-[var(--studio-line-strong)]',
        'transition-colors duration-200 ease-out cursor-pointer',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--studio-bg)]',
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
