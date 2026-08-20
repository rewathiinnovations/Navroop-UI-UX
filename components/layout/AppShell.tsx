'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { Menu } from 'lucide-react';
import { cn } from '@/utils/cn';

/**
 * App chrome around the sidebar. Below `md` the sidebar is an overlay drawer
 * so a 390px phone is not eaten by a 272px rail. Desktop collapse stays on
 * the sidebar itself.
 */
export default function AppShell({
  sidebar,
  children,
}: {
  sidebar: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mobileOpen]);

  return (
    <div className="studio-shell relative flex h-dvh min-h-0 overflow-hidden">
      <div className="studio-glow" aria-hidden />
      {mobileOpen ? (
        <button
          type="button"
          aria-label="Close menu"
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      ) : null}
      <div
        className={cn(
          'z-40 flex h-full min-h-0 shrink-0',
          'max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:transition-transform max-md:duration-200',
          mobileOpen ? 'max-md:translate-x-0' : 'max-md:-translate-x-full',
        )}
      >
        {sidebar}
      </div>
      <div className="relative z-10 flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex h-52 shrink-0 items-center gap-8 border-b border-[var(--studio-line)] bg-[var(--studio-header-bg)] px-8 md:hidden">
          <button
            type="button"
            aria-label="Open menu"
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen(true)}
            className="studio-icon-hit inline-flex items-center justify-center rounded-10 text-[var(--studio-muted)] transition-colors duration-200 hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
          >
            <Menu className="size-18" aria-hidden />
          </button>
          <span className="text-[14px] font-semibold text-[var(--studio-fg)]">Navroop</span>
        </div>
        <div className="studio-scroll relative min-h-0 min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
