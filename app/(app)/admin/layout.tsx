import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { redirect } from 'next/navigation';
import AdminNav from '@/components/admin/AdminNav';
import StudioLogo from '@/components/app/studio/StudioLogo';
import { requireAdmin } from '@/lib/auth';

/**
 * Admin had no layout at all: every page picked its own width, padding, and
 * copy of the navigation. This gates the whole section once and gives all of
 * admin one frame — a fixed icon-led rail plus a scrolling content column —
 * so individual pages only ever supply their content.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const { user } = await requireAdmin();
  if (!user) redirect('/dashboard');

  return (
    <div className="flex min-h-full">
      <aside className="hidden w-[228px] shrink-0 flex-col border-r border-[var(--studio-line)] bg-[var(--studio-surface)]/40 lg:flex">
        <div className="flex items-center justify-between px-16 py-16">
          <StudioLogo href="/dashboard" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-10 pb-24">
          <AdminNav />
        </div>
        <div className="border-t border-[var(--studio-line)] px-10 py-12">
          <Link
            href="/dashboard"
            className="flex min-h-36 items-center gap-10 rounded-10 px-10 text-[13px] text-[var(--studio-muted)] transition-colors duration-200 hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)]"
          >
            <ArrowLeft className="size-15 shrink-0" aria-hidden />
            Back to workspace
          </Link>
        </div>
      </aside>

      <div className="min-w-0 flex-1 px-20 py-28 lg:px-40 lg:py-36">
        <div className="mb-24 lg:hidden">
          <AdminNav />
        </div>
        {children}
      </div>
    </div>
  );
}
