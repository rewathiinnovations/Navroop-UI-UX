"use client";

import { FormEvent, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { ArrowUp, Loader2 } from "lucide-react";
import { cn } from "@/utils/cn";

export const PROMPT_PLACEHOLDER =
  "Describe what you want to build, or paste a URL to clone…";

type PromptBoxProps = {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  submitting?: boolean;
  textareaRef?: Ref<HTMLTextAreaElement>;
  footerLeft?: ReactNode;
  className?: string;
  label?: string;
};

export default function PromptBox({
  id = "hero-prompt",
  value,
  onChange,
  onSubmit,
  placeholder = PROMPT_PLACEHOLDER,
  submitting = false,
  textareaRef,
  footerLeft,
  className,
  label = "Describe what you want to build",
}: PromptBoxProps) {
  const submit = (next = value) => {
    const trimmed = next.trim();
    if (!trimmed || submitting) return;
    onSubmit(trimmed);
  };

  const onFormSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form onSubmit={onFormSubmit} className={cn("w-full", className)}>
      {/* The "type an idea" moment. Focus doesn't snap a hard ring on — the
          border warms to the accent and a soft glow rises under the box, so
          starting a project feels like the surface waking up. Both layers are
          box-shadow/border-color only; reduced motion just skips the ease. */}
      <div
        className={cn(
          'rounded-12 border border-[var(--studio-line-strong)] bg-[var(--studio-surface)]',
          'shadow-[0_8px_30px_rgba(24,24,27,0.06)]',
          'transition-[border-color,box-shadow] duration-300 ease-out motion-reduce:transition-none',
          'focus-within:border-[var(--studio-accent)]/55',
          'focus-within:shadow-[0_0_0_3px_var(--studio-accent-soft),0_12px_40px_rgba(24,24,27,0.1)]',
        )}
      >
        <label htmlFor={id} className="sr-only">
          {label}
        </label>
        <textarea
          id={id}
          ref={textareaRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          rows={4}
          placeholder={placeholder}
          className="w-full resize-none bg-transparent px-20 pt-16 pb-8 text-[16px] leading-6 text-[var(--studio-fg)] placeholder:text-[var(--studio-faint)] focus-visible:outline-none"
        />
        <div className="flex items-center justify-between px-12 pb-12">
          <div className="flex min-h-[44px] flex-wrap items-center gap-6">{footerLeft}</div>
          <button
            type="submit"
            disabled={!value.trim() || submitting}
            aria-label="Create project"
            className={cn(
              'group inline-flex size-[44px] items-center justify-center rounded-full',
              '[background-image:var(--studio-cta-gradient)] text-white hover:brightness-[1.07]',
              'disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer',
              'transition-[background-color,transform,filter] duration-200',
              'active:scale-95 disabled:active:scale-100 motion-reduce:transition-none motion-reduce:active:scale-100',
            )}
          >
            {submitting ? (
              <Loader2 className="size-18 animate-spin motion-reduce:animate-none" />
            ) : (
              <ArrowUp className="size-18 transition-transform duration-200 group-hover:-translate-y-2 motion-reduce:transition-none motion-reduce:group-hover:translate-y-0" />
            )}
          </button>
        </div>
      </div>
    </form>
  );
}
