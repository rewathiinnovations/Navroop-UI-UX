import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';

export default function Hint({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn('relative inline-flex group/hint', className)}>
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-50 mt-8 -translate-x-1/2 whitespace-nowrap rounded-8 bg-[var(--studio-fg)] px-8 py-4 text-[11px] leading-4 text-[var(--studio-bg)] opacity-0 shadow-sm transition-opacity duration-150 group-hover/hint:opacity-100 group-focus-within/hint:opacity-100"
      >
        {label}
      </span>
    </span>
  );
}
