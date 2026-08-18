import { ReactNode } from 'react';
import { cn } from '@/utils/cn';

/**
 * A status badge with a real tinted background, not just an outline and a
 * 6px dot — the outline-only version was nearly invisible against a white
 * card (confirmed by a user screenshot: "Active" read as a barely-there gray
 * line). Every admin status indicator — team, servers, templates, settings
 * source, integration connection — reads through one of these five tones.
 */
const TONE = {
  positive: {
    dot: 'bg-[var(--studio-accent)]',
    classes:
      'border-[var(--studio-accent)]/25 bg-[var(--studio-accent)]/10 text-[var(--studio-accent)]',
  },
  warning: {
    dot: 'bg-amber-500',
    classes: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  },
  danger: {
    dot: 'bg-[var(--studio-danger)]',
    classes:
      'border-[var(--studio-danger)]/25 bg-[var(--studio-danger)]/10 text-[var(--studio-danger)]',
  },
  neutral: {
    dot: 'bg-[var(--studio-muted)]',
    classes:
      'border-[var(--studio-line-strong)] bg-[var(--studio-skeleton)] text-[var(--studio-muted)]',
  },
  faint: {
    dot: 'bg-[var(--studio-faint)]',
    classes: 'border-dashed border-[var(--studio-line)] bg-transparent text-[var(--studio-faint)]',
  },
} as const;

export type StatusTone = keyof typeof TONE;

export default function StatusPill({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  const t = TONE[tone];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-6 whitespace-nowrap rounded-full border px-8 py-3 text-[11px] font-medium',
        t.classes,
      )}
    >
      <span className={cn('size-6 shrink-0 rounded-full', t.dot)} aria-hidden />
      {children}
    </span>
  );
}
