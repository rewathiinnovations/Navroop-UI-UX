import { TextareaHTMLAttributes } from 'react';
import { cn } from '@/utils/cn';

type StudioTextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  id: string;
  label: string;
  hint?: string;
};

/** Multi-line counterpart to StudioField, with the same label treatment. */
export default function StudioTextarea({
  id,
  label,
  hint,
  className,
  rows = 4,
  ...attrs
}: StudioTextareaProps) {
  return (
    <div className="space-y-8">
      <label htmlFor={id} className="block text-[13px] font-medium text-[var(--studio-fg)]">
        {label}
      </label>
      <textarea
        id={id}
        rows={rows}
        {...attrs}
        className={cn(
          'w-full px-14 py-12 rounded-10 resize-y',
          'bg-[var(--studio-surface)] text-[14px] leading-6 text-[var(--studio-fg)]',
          'border border-[var(--studio-line-strong)]',
          'placeholder:text-[var(--studio-faint)]',
          'transition-[border-color,box-shadow] duration-200',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)] focus-visible:border-transparent',
          className,
        )}
      />
      {hint && <p className="text-[12px] leading-5 text-[var(--studio-muted)]">{hint}</p>}
    </div>
  );
}
