'use client';

import { Loader2 } from 'lucide-react';
import type { PlanTrigger } from './types';

export default function BuildingIndicator({
  trigger,
  queueAhead,
}: {
  trigger?: PlanTrigger | null;
  queueAhead?: number | null;
}) {
  const label =
    queueAhead && queueAhead > 0
      ? `In queue — ${queueAhead} builds ahead`
      : trigger === 'followup'
        ? 'Building your changes…'
        : 'Building your project…';

  return (
    <div
      role="status"
      aria-live="polite"
      className="relative mb-16 flex items-center gap-8 overflow-hidden rounded-16 border border-[var(--studio-line)] bg-[var(--studio-bg)] px-14 py-10 text-[13px] text-[var(--studio-muted)]"
    >
      <Loader2 className="size-15 shrink-0 animate-spin text-[var(--studio-accent)] motion-reduce:animate-none" />
      <span>{label}</span>
      {/* Light traveling the bottom edge — the build reads as alive even when
          no chat frame has arrived yet. Honest: it shows activity, never progress. */}
      <span aria-hidden className="absolute inset-x-0 bottom-0 h-2 overflow-hidden">
        <span className="studio-sheen block h-full w-1/4 rounded-full bg-gradient-to-r from-transparent via-[var(--studio-accent)] to-transparent" />
      </span>
    </div>
  );
}
