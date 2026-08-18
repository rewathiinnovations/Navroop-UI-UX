import { ReactNode } from 'react';
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
    <div className="overflow-x-auto rounded-12 border border-[var(--studio-line)]">
      <table className={cn('w-full min-w-[520px] border-collapse text-[13px]', className)}>
        <thead>
          <tr className="border-b border-[var(--studio-line)] text-left text-[11px] uppercase tracking-[0.08em] text-[var(--studio-faint)]">
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

export function Tr({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <tr className={cn('border-b border-[var(--studio-line)] last:border-b-0', className)}>
      {children}
    </tr>
  );
}

export function Td({
  children,
  className,
  align = 'left',
}: {
  children: ReactNode;
  className?: string;
  align?: 'left' | 'right';
}) {
  return (
    <td
      className={cn(
        'px-14 py-12 align-middle text-[var(--studio-fg)]',
        align === 'right' && 'text-right',
        className,
      )}
    >
      {children}
    </td>
  );
}

export function AdminEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-12 border border-dashed border-[var(--studio-line)] px-20 py-28 text-center text-[13px] text-[var(--studio-muted)]">
      {children}
    </div>
  );
}
