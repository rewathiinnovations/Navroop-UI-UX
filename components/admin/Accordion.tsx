'use client';

import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/utils/cn';

/**
 * A collapsible section for content that is useful but shouldn't dominate
 * the page by default — a create-form on a page whose main job is showing
 * the list, an optional detail block, a secondary form. Closed by default
 * unless `defaultOpen` says otherwise.
 */
export default function Accordion({
  title,
  description,
  icon,
  defaultOpen = false,
  children,
  badge,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  /** e.g. a count, shown next to the title whether open or closed. */
  badge?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = `accordion-${title.replace(/\s+/g, '-').toLowerCase()}`;

  return (
    <div className="overflow-hidden rounded-14 border border-[var(--studio-line)] bg-[var(--studio-surface)] shadow-[0_8px_30px_rgba(24,24,27,0.06)] dark:shadow-[0_8px_30px_rgba(0,0,0,0.28)]">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center gap-10 px-20 py-16 text-left transition-colors duration-150 hover:bg-[var(--studio-surface-hover)]"
      >
        {icon && (
          <span className="inline-flex size-28 shrink-0 items-center justify-center rounded-8 bg-[var(--studio-bg)] text-[var(--studio-muted)]">
            {icon}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-8">
            <span className="text-[15px] font-medium text-[var(--studio-fg)]">{title}</span>
            {badge}
          </span>
          {description && (
            <span className="mt-2 block text-[13px] leading-5 text-[var(--studio-muted)]">
              {description}
            </span>
          )}
        </span>
        <ChevronDown
          className={cn(
            'size-16 shrink-0 text-[var(--studio-faint)] transition-transform duration-200',
            open && 'rotate-180',
          )}
          aria-hidden
        />
      </button>
      <div
        id={id}
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out',
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div className="overflow-hidden">
          <div className="border-t border-[var(--studio-line)] p-20">{children}</div>
        </div>
      </div>
    </div>
  );
}
