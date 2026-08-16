import Link from "next/link";
import { ButtonHTMLAttributes, ReactNode, forwardRef } from "react";
import { cn } from "@/utils/cn";

type Variant = "primary" | "inverted" | "ghost" | "danger";

const buttonClass = (variant: Variant, className?: string) =>
  cn(
    "inline-flex items-center justify-center gap-8 min-h-[44px] px-18 rounded-full",
    "text-[14px] font-medium tracking-[-0.01em] cursor-pointer no-underline",
    "transition-colors duration-200 ease-out",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--studio-bg)]",
    "disabled:opacity-50 disabled:cursor-not-allowed",
    variant === "primary" &&
      "bg-[var(--studio-accent)] text-[var(--studio-cta-fg)] hover:bg-[var(--studio-accent-hover)] disabled:hover:bg-[var(--studio-accent)]",
    variant === "inverted" &&
      "bg-[var(--studio-fg)] text-[var(--studio-bg)] hover:opacity-90 disabled:hover:opacity-100",
    variant === "ghost" &&
      "bg-transparent text-[var(--studio-fg)] border border-[var(--studio-line-strong)] hover:bg-[var(--studio-surface)]",
    variant === "danger" &&
      "bg-transparent text-[var(--studio-muted)] hover:text-[var(--studio-danger)]",
    className,
  );

interface StudioButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  href?: string;
  children: ReactNode;
}

const StudioButton = forwardRef<HTMLButtonElement, StudioButtonProps>(
  ({ variant = "primary", className, disabled, type, href, children, ...attrs }, ref) => {
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
        type={type ?? "button"}
        disabled={disabled}
        className={buttonClass(variant, className)}
      >
        {children}
      </button>
    );
  },
);

StudioButton.displayName = "StudioButton";

export default StudioButton;
