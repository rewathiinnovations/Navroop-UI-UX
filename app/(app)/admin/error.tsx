'use client';

import SegmentError from '@/components/errors/SegmentError';

/**
 * Admin has its own frame — the icon rail plus the content column in `admin/layout.tsx` —
 * and every page under it is an async dashboard reading live infrastructure. A failing
 * provider check or a Coolify timeout used to blow away the rail with the page (F-445);
 * here the rail survives, so the operator can move to another dashboard instead of
 * navigating back in from `/dashboard`.
 */
export default function AdminSegmentError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <SegmentError
      error={error}
      reset={reset}
      scope="admin"
      title="This dashboard failed to load"
      message="Something went wrong reading this dashboard. The other admin pages still work."
      retryLabel="Reload this dashboard"
    />
  );
}
