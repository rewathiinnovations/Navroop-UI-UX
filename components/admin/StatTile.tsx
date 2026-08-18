import { ReactNode } from 'react';
import { cn } from '@/utils/cn';

/**
 * A single KPI number with an icon and label — the thing the admin home page
 * lacked entirely. It answered "where do I click" but never "how many, how
 * much, how healthy," which is what an operator actually opens the page to
 * find out.
 */
export default function StatTile({
  icon,
  label,
  value,
  hint,
  href,
  tone = 'default',
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  hint?: string;
  href?: string;
  tone?: 'default' | 'danger' | 'warning';
}) {
  const Tag = href ? 'a' : 'div';
  return (
    <Tag
      {...(href ? { href } : {})}
      className={cn(
        'relative flex items-start gap-12 overflow-hidden rounded-14 border border-[var(--studio-line)] bg-[var(--studio-surface)] p-16',
        'shadow-[0_8px_30px_rgba(24,24,27,0.06)] dark:shadow-[0_8px_30px_rgba(0,0,0,0.28)]',
        href &&
          'transition-[border-color,background-color,transform] duration-200 hover:-translate-y-1 hover:border-[var(--studio-line-strong)] hover:bg-[var(--studio-surface-hover)]',
      )}
    >
      {tone !== 'default' && (
        <span
          className={cn(
            'absolute inset-x-0 top-0 h-2',
            tone === 'danger' && 'bg-[var(--studio-danger)]',
            tone === 'warning' && 'bg-amber-500',
          )}
          aria-hidden
        />
      )}
      <span
        className={cn(
          'inline-flex size-34 shrink-0 items-center justify-center rounded-10',
          tone === 'danger' && 'bg-[var(--studio-danger)]/12 text-[var(--studio-danger)]',
          tone === 'warning' && 'bg-amber-500/12 text-amber-500',
          tone === 'default' && 'bg-[var(--studio-accent-soft)] text-[var(--studio-accent)]',
        )}
      >
        {icon}
      </span>
      <div className="min-w-0">
        {/* tabular-nums so 111 and 999 occupy the same width and rows of tiles align. */}
        <p className="text-[22px] font-medium leading-tight tracking-[-0.01em] text-[var(--studio-fg)] tabular-nums">
          {value}
        </p>
        <p className="mt-2 text-[12px] text-[var(--studio-muted)]">{label}</p>
        {hint && <p className="mt-1 text-[11px] text-[var(--studio-faint)]">{hint}</p>}
      </div>
    </Tag>
  );
}
