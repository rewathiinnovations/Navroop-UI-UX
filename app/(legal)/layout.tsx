import type { ReactNode } from 'react';
import Link from 'next/link';
import StudioLogo from '@/components/app/studio/StudioLogo';
import '@/components/app/studio/studio.css';

export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="studio-shell min-h-dvh bg-[var(--studio-bg)] text-[var(--studio-fg)]">
      <header className="border-b border-[var(--studio-line)]">
        <div className="mx-auto flex h-[64px] max-w-[720px] items-center justify-between px-20">
          <StudioLogo href="/" />
          <nav className="flex gap-16 text-[13px]" aria-label="Legal">
            <Link href="/terms" className="text-[var(--studio-muted)] hover:text-[var(--studio-fg)]">
              Terms
            </Link>
            <Link href="/privacy" className="text-[var(--studio-muted)] hover:text-[var(--studio-fg)]">
              Privacy
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-[720px] px-20 py-40">{children}</main>
    </div>
  );
}
