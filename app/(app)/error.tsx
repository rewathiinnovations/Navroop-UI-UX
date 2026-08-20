'use client';

import SegmentError from '@/components/errors/SegmentError';

/**
 * A throw in any authenticated page used to reach `app/error.tsx`, which sits above
 * `(app)/layout.tsx` — so the sidebar, the recents and the theme went with it and the user
 * was left on a bare page with no navigation (F-445). This boundary is inside the layout:
 * the shell stays, and only the content column is replaced.
 */
export default function AppSegmentError({
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
      scope="app"
      title="This page failed to load"
      message="Something went wrong. The rest of the workspace still works."
    />
  );
}
