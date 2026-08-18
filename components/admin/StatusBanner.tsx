import { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, TriangleAlert } from 'lucide-react';
import { cn } from '@/utils/cn';

/**
 * One banner for every outcome. Admin pages previously spelled this five
 * different ways across two different red tokens, so the same severity looked
 * different depending on which page you were on.
 */

type Tone = 'error' | 'success' | 'info' | 'warning';

const TONE = {
  error: {
    icon: AlertTriangle,
    role: 'alert' as const,
    badge: 'bg-[var(--studio-danger)]/12 text-[var(--studio-danger)]',
    border: 'border-[var(--studio-danger)]/25',
  },
  warning: {
    icon: TriangleAlert,
    role: 'status' as const,
    badge: 'bg-amber-500/12 text-amber-500',
    border: 'border-[var(--studio-line)]',
  },
  success: {
    icon: CheckCircle2,
    role: 'status' as const,
    badge: 'bg-[var(--studio-accent-soft)] text-[var(--studio-accent)]',
    border: 'border-[var(--studio-line)]',
  },
  info: {
    icon: Info,
    role: 'status' as const,
    badge: 'bg-[var(--studio-bg)] text-[var(--studio-muted)]',
    border: 'border-[var(--studio-line)]',
  },
};

export default function StatusBanner({
  tone,
  children,
  action,
  className,
}: {
  tone: Tone;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const { icon: Icon, role, badge, border } = TONE[tone];
  return (
    <div
      role={role}
      className={cn(
        'flex items-start gap-12 rounded-12 border bg-[var(--studio-surface)] p-14 text-[13px] leading-5 text-[var(--studio-fg)]',
        border,
        className,
      )}
    >
      <span
        className={cn('inline-flex size-26 shrink-0 items-center justify-center rounded-8', badge)}
      >
        <Icon className="size-14" aria-hidden />
      </span>
      <div className="min-w-0 flex-1 pt-1">{children}</div>
      {action && <div className="shrink-0 pt-1">{action}</div>}
    </div>
  );
}
