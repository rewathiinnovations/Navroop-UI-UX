'use client';

import { WifiOff } from 'lucide-react';
import { useOnline } from '@/hooks/useOnline';
import { OFFLINE_BANNER_LINE } from '@/lib/net/connection';

/**
 * The one place the product says it is offline (F-446).
 *
 * Mounted once beside the `Toaster` in `AppProviders`, so it covers every
 * authenticated page including the ones that do not go through `StudioShell`.
 * A toast would have been wrong: an offline stretch is a state that lasts, and a
 * toast is an event that scrolls away while the state is still true.
 *
 * `role="status"` with `aria-live="polite"`: it interrupts nothing, but it is
 * announced when it appears and again when it goes.
 */
export default function OfflineBanner() {
  const connection = useOnline();
  if (connection === 'online') return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 top-0 z-[100] flex items-center justify-center gap-8 bg-[var(--studio-danger)] px-16 py-8 text-center text-[13px] font-medium text-white"
    >
      <WifiOff className="size-14 shrink-0" aria-hidden />
      {OFFLINE_BANNER_LINE}
    </div>
  );
}
