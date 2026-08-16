'use client';

import { Loader2 } from 'lucide-react';
import type { PlanTrigger } from './types';

export default function BuildingIndicator({ trigger }: { trigger?: PlanTrigger | null }) {
  const label = trigger === 'followup' ? 'Building your changes…' : 'Building your project…';

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-16 flex items-center gap-8 rounded-16 border border-[var(--studio-line)] bg-[var(--studio-bg)] px-14 py-10 text-[13px] text-[var(--studio-muted)]"
    >
      <Loader2 className="size-15 shrink-0 animate-spin text-[var(--studio-accent)]" />
      <span>{label}</span>
    </div>
  );
}
