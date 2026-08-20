'use client';

import SegmentError from '@/components/errors/SegmentError';

/**
 * The workspace is outside `(app)`, so it has no sidebar to fall back on and a throw here
 * left the user on the root boundary with no route back to their projects (F-445). Retrying
 * the segment re-runs the page's own data load — the plan, the GitHub status, the phase —
 * without discarding the browser session.
 */
export default function ProjectSegmentError({
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
      scope="workspace"
      title="This project failed to open"
      message="Something went wrong loading the workspace. Your files and history are unaffected."
      retryLabel="Reopen the project"
      backHref="/dashboard"
    />
  );
}
