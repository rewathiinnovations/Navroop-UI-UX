'use client';

import Link from 'next/link';
import { TEMPLATE_CATEGORIES, TEMPLATE_CATEGORY_LABELS } from '@/lib/templates/categories';

const CHIP =
  'inline-flex min-h-[32px] items-center rounded-full border px-12 text-[12px] transition-colors duration-200';

export default function CategoryChips({
  active,
  hrefBase = '/templates',
}: {
  active?: string | null;
  hrefBase?: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-6" role="navigation" aria-label="Template categories">
      <Link
        href={hrefBase}
        className={
          !active
            ? `${CHIP} border-[var(--studio-fg)] bg-[var(--studio-surface)] text-[var(--studio-fg)]`
            : `${CHIP} border-[var(--studio-line-strong)] text-[var(--studio-muted)] hover:text-[var(--studio-fg)]`
        }
      >
        All
      </Link>
      {TEMPLATE_CATEGORIES.map((id) => (
        <Link
          key={id}
          href={`${hrefBase}?category=${id}`}
          className={
            active === id
              ? `${CHIP} border-[var(--studio-fg)] bg-[var(--studio-surface)] text-[var(--studio-fg)]`
              : `${CHIP} border-[var(--studio-line-strong)] text-[var(--studio-muted)] hover:text-[var(--studio-fg)]`
          }
        >
          {TEMPLATE_CATEGORY_LABELS[id]}
        </Link>
      ))}
    </div>
  );
}
