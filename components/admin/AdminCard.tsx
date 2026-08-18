import { ReactNode } from 'react';
import { cn } from '@/utils/cn';

/**
 * A titled section. The surface styling here was previously copy-pasted as a
 * literal class string in 29 places across 8 files.
 */
export default function AdminCard({
  title,
  description,
  actions,
  children,
  id,
  className,
  padded = true,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  /** Anchor target, so long pages can link to their own sections. */
  id?: string;
  className?: string;
  /** Turn off for edge-to-edge content such as a full-bleed table. */
  padded?: boolean;
}) {
  return (
    <section
      id={id}
      className={cn(
        'rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)]',
        padded && 'p-20',
        className,
      )}
    >
      {(title || actions) && (
        <div
          className={cn(
            'mb-16 flex flex-wrap items-start justify-between gap-12',
            !padded && 'px-20 pt-20',
          )}
        >
          <div className="min-w-0">
            {title && <h2 className="text-[16px] font-medium text-[var(--studio-fg)]">{title}</h2>}
            {description && (
              <p className="mt-4 max-w-[62ch] text-[13px] leading-5 text-[var(--studio-muted)]">
                {description}
              </p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-8">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
