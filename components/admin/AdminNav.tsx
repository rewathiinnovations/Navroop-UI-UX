'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/utils/cn';
import { ADMIN_NAV, isAdminNavItemActive } from './admin-nav';

/**
 * Grouped admin navigation, rendered from the one nav definition.
 *
 * Grouping is the point: fourteen flat tabs gave no sense of what belonged with
 * what, and the strip silently changed between pages because six copies of the
 * list had drifted.
 */
export default function AdminNav() {
  const pathname = usePathname() || '';

  return (
    <nav aria-label="Admin" className="flex flex-col gap-20">
      {ADMIN_NAV.map((group) => (
        <div key={group.group}>
          <p className="mb-6 px-10 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--studio-faint)]">
            {group.group}
          </p>
          <div className="flex flex-col gap-2">
            {group.items.map((item) => {
              const active = isAdminNavItemActive(item, pathname);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={item.description}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex min-h-36 items-center rounded-8 px-10 text-[13px] transition-colors duration-200',
                    active
                      ? 'bg-[var(--studio-surface)] font-medium text-[var(--studio-fg)]'
                      : 'text-[var(--studio-muted)] hover:bg-[var(--studio-surface)] hover:text-[var(--studio-fg)]',
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}
