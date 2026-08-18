import { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { cn } from '@/utils/cn';

/**
 * One banner for every outcome. Admin pages previously spelled this five
 * different ways across two different red tokens, so the same severity looked
 * different depending on which page you were on.
 */

type Tone = 'error' | 'success' | 'info';

const TONE = {
  error: {
    icon: AlertTriangle,
    role: 'alert' as const,
    className: 'border-[var(--studio-danger)]/30 text-[var(--studio-danger)]',
  },
  success: {
    icon: CheckCircle2,
    role: 'status' as const,
    className: 'border-[var(--studio-line)] text-[var(--studio-fg)]',
  },
  info: {
    icon: Info,
    role: 'status' as const,
    className: 'border-[var(--studio-line)] text-[var(--studio-muted)]',
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
  const { icon: Icon, role, className: toneClass } = TONE[tone];
  return (
    <div
      role={role}
      className={cn(
        'flex items-start gap-12 rounded-12 border bg-[var(--studio-surface)] px-16 py-12 text-[13px] leading-5',
        toneClass,
        className,
      )}
    >
      <Icon className="mt-1 size-15 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
