import { ReactNode } from 'react';
import { Inbox } from 'lucide-react';
import { cn } from '@/utils/cn';

/**
 * A table with one set of paddings, one header treatment, and a built-in empty
 * state — the thing four admin tables were missing, so zero rows rendered as a
 * bare header with nothing underneath.
 */

export function AdminTable({
  head,
  children,
  empty,
  isEmpty,
  className,
}: {
  head: ReactNode;
  children: ReactNode;
  /** Shown instead of the table body when `isEmpty`. Always supply one. */
  empty: ReactNode;
  isEmpty: boolean;
  className?: string;
}) {
  if (isEmpty) {
    return <AdminEmpty>{empty}</AdminEmpty>;
  }
  return (
    <div className="overflow-x-auto rounded-14 border border-[var(--studio-line)]">
      <table className={cn('w-full min-w-[520px] border-collapse text-[13px]', className)}>
        <thead>
          <tr className="border-b border-[var(--studio-line)] bg-[var(--studio-bg)]/60 text-left text-[11px] uppercase tracking-[0.08em] text-[var(--studio-faint)]">
            {head}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Th({
  children,
  className,
  align = 'left',
}: {
  children: ReactNode;
  className?: string;
  align?: 'left' | 'right';
}) {
  return (
    <th
      scope="col"
      className={cn(
        'whitespace-nowrap px-14 py-10 font-medium',
        align === 'right' && 'text-right',
        className,
      )}
    >
      {children}
    </th>
  );
}

/**
 * Deliberately has no `onClick`: a bare `<tr onClick>` is invisible to the
 * keyboard, and the one caller that used it (usage → by member) hid the page's
 * whole drill-down behind a mouse. Row-level actions go in a `<button>` inside
 * a `<Td>`.
 */
export function Tr({
  children,
  className,
  id,
}: {
  children: ReactNode;
  className?: string;
  /** Target for an `aria-controls` on the row that expands this one. */
  id?: string;
}) {
  return (
    <tr
      id={id}
      className={cn(
        'border-b border-[var(--studio-line)] transition-colors duration-150 last:border-b-0 hover:bg-[var(--studio-surface-hover)]',
        className,
      )}
    >
      {children}
    </tr>
  );
}

export function Td({
  children,
  className,
  align = 'left',
  muted = false,
  mono = false,
  colSpan,
}: {
  children: ReactNode;
  className?: string;
  align?: 'left' | 'right';
  /** Secondary detail — dates, ids as sub-text. */
  muted?: boolean;
  /** Ids and other machine-generated strings read better fixed-width. */
  mono?: boolean;
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      className={cn(
        'px-14 py-12 align-middle',
        muted ? 'text-[var(--studio-muted)]' : 'text-[var(--studio-fg)]',
        mono && 'font-mono text-[12px]',
        align === 'right' && 'text-right',
        className,
      )}
    >
      {children}
    </td>
  );
}

export function AdminEmpty({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-10 rounded-14 border border-dashed border-[var(--studio-line)] px-20 py-36 text-center">
      <span className="inline-flex size-32 items-center justify-center rounded-10 bg-[var(--studio-bg)] text-[var(--studio-faint)]">
        {icon ?? <Inbox className="size-16" aria-hidden />}
      </span>
      <p className="text-[13px] text-[var(--studio-muted)]">{children}</p>
    </div>
  );
}
