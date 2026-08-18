'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/utils/cn';
import { ADMIN_NAV, isAdminNavItemActive } from './admin-nav';
import AdminIcon from './AdminIcon';

/**
 * Grouped, icon-led admin navigation, rendered from the one nav definition.
 *
 * The icon carries recognition once someone has used a section a few times —
 * text-only rows all look the same at a glance, which is part of why the old
 * flat tab strip gave no sense of place. The active row gets a filled pill in
 * the accent-soft token rather than a plain underline, so "where am I" reads
 * from peripheral vision, not from parsing text.
 */
export default function AdminNav() {
  const pathname = usePathname() || '';

  return (
    <nav aria-label="Admin" className="flex flex-col gap-18">
      {ADMIN_NAV.map((group) => (
        <div key={group.group}>
          <p className="mb-6 px-10 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--studio-faint)]">
            {group.group}
          </p>
          <div className="flex flex-col gap-1">
            {group.items.map((item) => {
              const active = isAdminNavItemActive(item, pathname);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={item.description}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'group flex min-h-38 items-center gap-10 rounded-10 px-10 text-[13px] transition-colors duration-200',
                    active
                      ? 'bg-[var(--studio-accent-soft)] font-medium text-[var(--studio-accent)]'
                      : 'text-[var(--studio-muted)] hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)]',
                  )}
                >
                  <AdminIcon
                    name={item.icon}
                    className={cn(
                      'size-15 shrink-0',
                      active
                        ? 'text-[var(--studio-accent)]'
                        : 'text-[var(--studio-faint)] group-hover:text-[var(--studio-muted)]',
                    )}
                  />
                  <span className="truncate">{item.label}</span>
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}
