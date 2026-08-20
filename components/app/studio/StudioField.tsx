"use client";

import { InputHTMLAttributes, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/utils/cn";

type StudioFieldProps = InputHTMLAttributes<HTMLInputElement> & {
  id: string;
  label: string;
  revealable?: boolean;
};

export default function StudioField({
  id,
  label,
  className,
  type,
  revealable,
  ...attrs
}: StudioFieldProps) {
  const [revealed, setRevealed] = useState(false);
  const canReveal = Boolean(revealable && type === "password");
  const inputType = canReveal && revealed ? "text" : type;

  return (
    <div className="space-y-8">
      <label
        htmlFor={id}
        className="block text-[13px] font-medium text-[var(--studio-fg)]"
      >
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type={inputType}
          {...attrs}
          className={cn(
            "w-full h-44 px-16 rounded-full",
            canReveal && "pr-48",
            "bg-[var(--studio-surface)] text-[15px] text-[var(--studio-fg)]",
            "border border-[var(--studio-line-strong)]",
            "placeholder:text-[var(--studio-faint)]",
            "transition-[border-color,box-shadow] duration-200",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)] focus-visible:border-transparent",
            className,
          )}
        />
        {canReveal ? (
          <button
            type="button"
            onClick={() => setRevealed((value) => !value)}
            aria-label={revealed ? "Hide password" : "Show password"}
            className="studio-icon-hit absolute top-1/2 right-4 -translate-y-1/2 inline-flex items-center justify-center rounded-full text-[var(--studio-muted)] hover:text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
          >
            {revealed ? <EyeOff className="size-16" aria-hidden /> : <Eye className="size-16" aria-hidden />}
          </button>
        ) : null}
      </div>
    </div>
  );
}
