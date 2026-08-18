import Link from 'next/link';
import { ButtonHTMLAttributes, ReactNode, forwardRef } from 'react';
import { cn } from '@/utils/cn';

type Variant = 'primary' | 'inverted' | 'ghost' | 'danger';

const buttonClass = (variant: Variant, className?: string) =>
  cn(
    'inline-flex items-center justify-center gap-8 min-h-[44px] px-18 rounded-full',
    'text-[14px] font-medium tracking-[-0.01em] cursor-pointer no-underline',
    // Compositor-only feedback: colors morph, and a press dips the button just
    // enough to feel mechanical. Reduced motion keeps color, drops movement.
    'transition-[background-color,border-color,color,opacity,transform,filter] duration-200 ease-out',
    'active:scale-[0.98] active:duration-75 motion-reduce:transition-none motion-reduce:active:scale-100',
    'disabled:active:scale-100',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--studio-bg)]',
    'disabled:opacity-50 disabled:cursor-not-allowed',
    variant === 'primary' &&
      '[background-image:var(--studio-cta-gradient)] text-[var(--studio-cta-fg)] hover:brightness-[1.07] active:brightness-95 disabled:hover:brightness-100',
    variant === 'inverted' &&
      'bg-[var(--studio-fg)] text-[var(--studio-bg)] hover:opacity-90 disabled:hover:opacity-100',
    variant === 'ghost' &&
      'bg-[var(--studio-skeleton)] text-[var(--studio-fg)] border border-[var(--studio-line-strong)] hover:bg-[var(--studio-surface-hover)] hover:border-[var(--studio-accent)]/50 disabled:hover:bg-[var(--studio-skeleton)] disabled:hover:border-[var(--studio-line-strong)]',
    variant === 'danger' &&
      'bg-[var(--studio-danger)]/8 text-[var(--studio-danger)] border border-[var(--studio-danger)]/30 hover:bg-[var(--studio-danger)]/14 hover:border-[var(--studio-danger)]/55 disabled:hover:bg-[var(--studio-danger)]/8 disabled:hover:border-[var(--studio-danger)]/30',
    className,
  );

interface StudioButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  href?: string;
  children: ReactNode;
}

const StudioButton = forwardRef<HTMLButtonElement, StudioButtonProps>(
  ({ variant = 'primary', className, disabled, type, href, children, ...attrs }, ref) => {
    if (href && !disabled) {
      return (
        <Link href={href} className={buttonClass(variant, className)}>
          {children}
        </Link>
      );
    }

    return (
      <button
        {...attrs}
        ref={ref}
        type={type ?? 'button'}
        disabled={disabled}
        className={buttonClass(variant, className)}
      >
        {children}
      </button>
    );
  },
);

StudioButton.displayName = 'StudioButton';

export default StudioButton;
