import { ReactNode } from 'react';
import { cn } from '@/utils/cn';

/**
 * A titled section. The surface styling here was previously copy-pasted as a
 * literal class string in 29 places across 8 files.
 */
export default function AdminCard({
  title,
  description,
  icon,
  actions,
  children,
  id,
  className,
  padded = true,
  tone = 'default',
}: {
  title?: string;
  description?: ReactNode;
  /** A small icon rendered before the title — pass any lucide element. */
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** Anchor target, so long pages can link to their own sections. */
  id?: string;
  className?: string;
  /** Turn off for edge-to-edge content such as a full-bleed table. */
  padded?: boolean;
  /** `accent` puts a colored rule on top — reserve it for one emphasized card per page. */
  tone?: 'default' | 'accent';
}) {
  return (
    <section
      id={id}
      className={cn(
        'relative overflow-hidden rounded-14 border border-[var(--studio-line)] bg-[var(--studio-surface)]',
        padded && 'p-20',
        className,
      )}
    >
      {tone === 'accent' && (
        <span className="absolute inset-x-0 top-0 h-2 bg-[var(--studio-accent)]" aria-hidden />
      )}
      {(title || actions) && (
        <div
          className={cn(
            'mb-16 flex flex-wrap items-start justify-between gap-12',
            !padded && 'px-20 pt-20',
          )}
        >
          <div className="flex min-w-0 items-start gap-10">
            {icon && (
              <span className="mt-1 inline-flex size-28 shrink-0 items-center justify-center rounded-8 bg-[var(--studio-bg)] text-[var(--studio-muted)]">
                {icon}
              </span>
            )}
            <div className="min-w-0">
              {title && (
                <h2 className="text-[15px] font-medium text-[var(--studio-fg)]">{title}</h2>
              )}
              {description && (
                <div className="mt-4 max-w-[62ch] text-[13px] leading-5 text-[var(--studio-muted)]">
                  {description}
                </div>
              )}
            </div>
          </div>
          {actions && <div className="flex shrink-0 items-center gap-8">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
