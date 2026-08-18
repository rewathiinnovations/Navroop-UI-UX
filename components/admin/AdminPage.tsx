import { ReactNode } from 'react';
import { cn } from '@/utils/cn';

/**
 * The heading block every admin page shares.
 *
 * Eleven pages used to render `<h1>Admin</h1>`, so the heading told you nothing
 * about where you were. A page now states its own name and what it is for, and
 * gets its width and spacing from here rather than choosing its own.
 */
export default function AdminPage({
  title,
  description,
  actions,
  children,
  width = 'default',
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  /** `wide` is for dense tables that genuinely need the room. */
  width?: 'default' | 'wide';
}) {
  return (
    <div className={cn('mx-auto w-full', width === 'wide' ? 'max-w-[1180px]' : 'max-w-[880px]')}>
      <header className="mb-24 flex flex-wrap items-start justify-between gap-16">
        <div className="min-w-0">
          <h1 className="text-[26px] font-medium tracking-[-0.02em] text-[var(--studio-fg)]">
            {title}
          </h1>
          {description && (
            <p className="mt-6 max-w-[62ch] text-[14px] leading-6 text-[var(--studio-muted)]">
              {description}
            </p>
          )}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-8">{actions}</div>}
      </header>
      <div className="space-y-20">{children}</div>
    </div>
  );
}
