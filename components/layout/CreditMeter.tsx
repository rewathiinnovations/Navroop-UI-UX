'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

type Meter = {
  used: number;
  limit: number;
  resetAt: string;
};

export default function CreditMeter() {
  const [meter, setMeter] = useState<Meter | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/settings/credits')
      .then((response) => (response.ok ? response.json() : null))
      .then((data: Meter | null) => {
        if (!cancelled && data && typeof data.used === 'number') setMeter(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!meter || meter.limit <= 0) return null;

  const ratio = Math.min(meter.used / meter.limit, 1);
  const tone =
    ratio >= 1 ? 'bg-rose-500' : ratio >= 0.8 ? 'bg-amber-500' : 'bg-[var(--studio-accent)]';
  const reset = new Date(meter.resetAt);
  const resetLabel = Number.isNaN(reset.getTime())
    ? ''
    : reset.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' });
  const title = resetLabel ? `Resets ${resetLabel}` : 'Credit usage';

  return (
    <Link
      href="/settings/usage"
      title={title}
      className="mb-8 block rounded-10 px-10 py-8 text-[12px] text-[var(--studio-muted)] transition-colors hover:bg-[var(--studio-surface-hover)]"
    >
      <div className="flex items-center justify-between gap-8">
        <span>
          {meter.used} / {meter.limit} credits
        </span>
      </div>
      <div
        className="mt-6 h-3 overflow-hidden rounded-full bg-[var(--studio-skeleton)]"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={meter.limit}
        aria-valuenow={meter.used}
        aria-label="Credits used this period"
      >
        <div
          className={`h-full rounded-full ${tone}`}
          style={{ width: `${Math.max(ratio * 100, meter.used > 0 ? 4 : 0)}%` }}
        />
      </div>
    </Link>
  );
}
