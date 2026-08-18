import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import AdminNav from '@/components/admin/AdminNav';
import { requireAdmin } from '@/lib/auth';

/**
 * Admin had no layout at all: every page picked its own width, padding, and
 * copy of the navigation. This gates the whole section once and gives all of
 * admin one frame, so pages only supply their content.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const { user } = await requireAdmin();
  if (!user) redirect('/dashboard');

  return (
    <div className="flex min-h-full">
      <aside className="hidden w-[212px] shrink-0 border-r border-[var(--studio-line)] px-10 py-24 lg:block">
        <p className="mb-20 px-10 text-[15px] font-medium tracking-[-0.01em] text-[var(--studio-fg)]">
          Admin
        </p>
        <AdminNav />
      </aside>
      <div className="min-w-0 flex-1 px-20 py-28 lg:px-32">
        <div className="mb-24 lg:hidden">
          <AdminNav />
        </div>
        {children}
      </div>
    </div>
  );
}
