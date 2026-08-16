import { useId } from "react";
import Link from "next/link";
import { cn } from "@/utils/cn";

export default function StudioLogo({
  href = "/dashboard",
  className,
}: {
  href?: string;
  className?: string;
}) {
  const gradientId = `ol${useId().replace(/:/g, "")}`;

  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center gap-10 min-h-[44px] rounded-12 px-2 -mx-2",
        "no-underline cursor-pointer",
        "transition-opacity duration-200 hover:opacity-80",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--studio-bg)]",
        className,
      )}
      aria-label="Navroop home"
    >
      <span className="relative flex size-28 shrink-0" aria-hidden>
        <svg viewBox="0 0 32 32" className="size-28" fill="none">
          <defs>
            <linearGradient id={gradientId} x1="6" y1="2" x2="26" y2="30" gradientUnits="userSpaceOnUse">
              <stop stopColor="#FF8A3D" />
              <stop offset="0.48" stopColor="#FF5C7A" />
              <stop offset="1" stopColor="#C084FC" />
            </linearGradient>
          </defs>
          <path
            d="M16.2 27.4c-6.4-4.6-10.7-8.9-10.7-14.1C5.5 9.2 8.6 6.4 12.2 6.4c2.1 0 3.9.9 5 2.4 1.1-1.5 2.9-2.4 5-2.4 3.6 0 6.7 2.8 6.7 6.9 0 5.2-4.3 9.5-10.7 14.1-.6.4-1.4.4-2 0Z"
            fill={`url(#${gradientId})`}
          />
        </svg>
      </span>
      <span className="font-wordmark text-[15px] font-semibold tracking-[-0.02em] text-[var(--studio-fg)]">
        Navroop
      </span>
    </Link>
  );
}
