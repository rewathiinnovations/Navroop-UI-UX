'use client';

import { useId, useState, type ReactNode } from 'react';
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
  // Derived from useId so N instances with the same `title` do not collide —
  // `TemplatesAdmin` renders one Accordion per template row.
  const id = `accordion-${useId()}`;
  // `grid-rows-[0fr]` + `overflow-hidden` only clipped the panel: its children
  // stayed in the tab order and in the accessibility tree while invisible, so
  // an admin tabbing through /admin/templates landed in every collapsed prompt
  // textarea on the page. `invisible` takes them out of both, `inert` also
  // blocks pointer and find-in-page, and neither breaks the grid-rows
  // transition the way `display: none` would.

  return (
    <div className="overflow-hidden rounded-14 border border-[var(--studio-line)] bg-[var(--studio-surface)] shadow-[0_8px_30px_rgba(24,24,27,0.06)] dark:shadow-[0_8px_30px_rgba(0,0,0,0.28)]">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center gap-10 px-20 py-16 text-left transition-colors duration-150 hover:bg-[var(--studio-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--studio-ring)]"
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
        inert={!open}
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out',
          open ? 'grid-rows-[1fr] visible' : 'grid-rows-[0fr] invisible',
        )}
      >
        <div className="overflow-hidden">
          <div className="border-t border-[var(--studio-line)] p-20">{children}</div>
        </div>
      </div>
    </div>
  );
}
