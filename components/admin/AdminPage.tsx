import { ReactNode } from 'react';
import Link from 'next/link';
import { cn } from '@/utils/cn';
import AdminIcon from './AdminIcon';
import type { AdminIconName } from './admin-nav';

/**
 * The heading block every admin page shares.
 *
 * Eleven pages used to render `<h1>Admin</h1>` with no icon and no sense of
 * where you'd come from, so the heading told you nothing about which of
 * fourteen pages you were on. A page now carries the same icon shown for it
 * in the rail, a breadcrumb back to the section root, and its own name and
 * purpose — and gets its width and spacing from here rather than choosing
 * its own.
 */
export default function AdminPage({
  icon,
  title,
  description,
  actions,
  children,
  width = 'default',
}: {
  icon: AdminIconName;
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  /** `wide` is for dense tables that genuinely need the room. */
  width?: 'default' | 'wide';
}) {
  return (
    <div className={cn('mx-auto w-full', width === 'wide' ? 'max-w-[1180px]' : 'max-w-[880px]')}>
      <Link
        href="/admin"
        className="mb-12 inline-flex items-center text-[12px] font-medium uppercase tracking-[0.06em] text-[var(--studio-faint)] transition-colors duration-200 hover:text-[var(--studio-muted)]"
      >
        Admin
      </Link>

      <header className="mb-28 flex flex-wrap items-start justify-between gap-16">
        <div className="flex min-w-0 items-start gap-14">
          <span
            className="mt-1 inline-flex size-40 shrink-0 items-center justify-center rounded-12 text-white shadow-[0_6px_16px_rgba(255,92,122,0.28)]"
            style={{
              background: 'linear-gradient(135deg, #FF8A3D 0%, #FF5C7A 55%, #C084FC 100%)',
            }}
          >
            <AdminIcon name={icon} className="size-19" />
          </span>
          <div className="min-w-0">
            <h1 className="text-[24px] font-medium tracking-[-0.02em] text-[var(--studio-fg)]">
              {title}
            </h1>
            {description && (
              <p className="mt-4 max-w-[62ch] text-[14px] leading-6 text-[var(--studio-muted)]">
                {description}
              </p>
            )}
          </div>
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-8">{actions}</div>}
      </header>

      <div className="space-y-20">{children}</div>
    </div>
  );
}
