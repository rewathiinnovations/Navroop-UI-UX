'use client';

import { useState, type ReactNode } from 'react';
import { cn } from '@/utils/cn';

/**
 * Real tab switching, not an anchor-chip row over one long scroll.
 *
 * Config and Health used to render every group's content at once and offer
 * `<a href="#id">` chips that only scrolled you to a position — every
 * section was still in the DOM and on screen, just further down. A page with
 * seven or eight sections is exactly the case tabs exist for: show one,
 * switch on click, and the page stops being a scroll marathon.
 */

export type AdminTab = {
  id: string;
  label: string;
  icon?: ReactNode;
  panel: ReactNode;
};

export default function AdminTabs({
  tabs,
  defaultTabId,
}: {
  tabs: AdminTab[];
  /** Falls back to the first tab. */
  defaultTabId?: string;
}) {
  const [active, setActive] = useState(defaultTabId ?? tabs[0]?.id);

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % tabs.length
        : (index - 1 + tabs.length) % tabs.length;
    setActive(tabs[next].id);
    document.getElementById(`admin-tab-${tabs[next].id}`)?.focus();
  };

  return (
    <div>
      <div
        role="tablist"
        aria-label="Sections"
        className="mb-20 flex flex-wrap gap-4 border-b border-[var(--studio-line)]"
      >
        {tabs.map((tab, index) => {
          const isActive = tab.id === active;
          return (
            <button
              key={tab.id}
              id={`admin-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`admin-panel-${tab.id}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => setActive(tab.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cn(
                'inline-flex min-h-40 items-center gap-8 border-b-2 px-12 text-[13px] transition-colors duration-200',
                isActive
                  ? 'border-[var(--studio-accent)] font-medium text-[var(--studio-fg)]'
                  : 'border-transparent text-[var(--studio-muted)] hover:text-[var(--studio-fg)]',
              )}
            >
              {tab.icon}
              {tab.label}
            </button>
          );
        })}
      </div>

      {tabs.map((tab) => (
        <div
          key={tab.id}
          id={`admin-panel-${tab.id}`}
          role="tabpanel"
          aria-labelledby={`admin-tab-${tab.id}`}
          hidden={tab.id !== active}
          className="space-y-20"
        >
          {tab.id === active && tab.panel}
        </div>
      ))}
    </div>
  );
}
