import { SelectHTMLAttributes } from 'react';
import { cn } from '@/utils/cn';

type StudioSelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  id: string;
  label: string;
  hint?: string;
};

/**
 * The labelled counterpart to StudioField. Admin had bare `<select>` elements
 * with no label and no placeholder, leaving the reader to guess what the
 * dropdown controlled.
 */
export default function StudioSelect({
  id,
  label,
  hint,
  className,
  children,
  ...attrs
}: StudioSelectProps) {
  return (
    <div className="space-y-8">
      <label htmlFor={id} className="block text-[13px] font-medium text-[var(--studio-fg)]">
        {label}
      </label>
      <select
        id={id}
        {...attrs}
        className={cn(
          'w-full h-44 px-14 rounded-10',
          'bg-[var(--studio-surface)] text-[15px] text-[var(--studio-fg)]',
          'border border-[var(--studio-line-strong)]',
          'transition-[border-color,box-shadow] duration-200',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)] focus-visible:border-transparent',
          className,
        )}
      >
        {children}
      </select>
      {hint && <p className="text-[12px] leading-5 text-[var(--studio-muted)]">{hint}</p>}
    </div>
  );
}
