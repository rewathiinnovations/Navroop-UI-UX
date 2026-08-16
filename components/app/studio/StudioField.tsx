import { InputHTMLAttributes } from "react";
import { cn } from "@/utils/cn";

type StudioFieldProps = InputHTMLAttributes<HTMLInputElement> & {
  id: string;
  label: string;
};

export default function StudioField({
  id,
  label,
  className,
  ...attrs
}: StudioFieldProps) {
  return (
    <div className="space-y-8">
      <label
        htmlFor={id}
        className="block text-[13px] font-medium text-[var(--studio-fg)]"
      >
        {label}
      </label>
      <input
        id={id}
        {...attrs}
        className={cn(
          "w-full h-44 px-16 rounded-full",
          "bg-[var(--studio-surface)] text-[15px] text-[var(--studio-fg)]",
          "border border-[var(--studio-line-strong)]",
          "placeholder:text-[var(--studio-faint)]",
          "transition-[border-color,box-shadow] duration-200",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)] focus-visible:border-transparent",
          className,
        )}
      />
    </div>
  );
}
