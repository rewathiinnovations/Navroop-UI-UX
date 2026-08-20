"use client";

import React from "react";
import { cn } from "@/utils/cn";

interface EmptyStateProps {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  title = "Nothing here yet",
  description,
  icon,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "relative flex flex-col items-center justify-center px-16 py-32 text-center",
        "min-h-[220px]",
        className,
      )}
    >
      {icon ? (
        <div className="mb-12 text-[var(--studio-faint)]" aria-hidden>
          {icon}
        </div>
      ) : null}

      <h3 className="text-[15px] font-medium text-[var(--studio-fg)]">{title}</h3>
      {description ? (
        <p className="mt-6 max-w-md text-[13px] leading-5 text-[var(--studio-muted)]">
          {description}
        </p>
      ) : null}

      {action ? <div className="mt-16">{action}</div> : null}
    </div>
  );
}
