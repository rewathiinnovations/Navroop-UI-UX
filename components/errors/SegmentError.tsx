'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect, useMemo } from 'react';
import Link from 'next/link';
import ErrorId from '@/components/errors/ErrorId';
import { errorRequestId } from '@/lib/errors/request-id';

/**
 * The body every per-segment `error.tsx` renders (F-445).
 *
 * The tree had one boundary, at the root, so a throw inside `/admin` or a project workspace
 * unmounted the whole chrome. The per-segment boundaries keep their frame — sidebar, admin
 * rail, workspace shell — and only the broken pane is replaced.
 *
 * The reporting is the part that must not be re-implemented per file. The nearest boundary
 * wins, so every boundary added below `app/error.tsx` takes errors away from it; one that
 * rendered an `ErrorId` and swallowed the exception would tell the user to quote an id
 * support cannot look up (F-436). `scope` is what makes the events separable once several
 * boundaries report.
 */
export default function SegmentError({
  error,
  reset,
  scope,
  title,
  retryLabel = 'Try again',
  message = 'Something went wrong loading this page.',
  backHref,
  backLabel = 'Back to dashboard',
}: {
  error: Error & { digest?: string };
  reset: () => void;
  /** Sentry tag and log event suffix, e.g. `admin`, `workspace`. */
  scope: string;
  title: string;
  retryLabel?: string;
  message?: string;
  /** Offered where the boundary replaces a frame that had no other navigation. */
  backHref?: string;
  backLabel?: string;
}) {
  const requestId = useMemo(() => errorRequestId(error.digest), [error.digest]);

  useEffect(() => {
    Sentry.captureException(error, { tags: { requestId, scope } });
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        event: `ui.segment.error.${scope}`,
        requestId,
        error: error.message,
        stack: process.env.NODE_ENV === 'production' ? undefined : error.stack,
      }),
    );
  }, [error, requestId, scope]);

  return (
    <div className="mx-auto max-w-[520px] px-20 py-40">
      <h1 className="mb-12 text-[24px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">
        {title}
      </h1>
      <ErrorId requestId={requestId} message={message} />
      <div className="mt-20 flex flex-wrap items-center gap-14">
        <button
          type="button"
          onClick={() => reset()}
          className="inline-flex h-36 items-center rounded-full bg-[var(--studio-fg)] px-14 text-[13px] text-[var(--studio-bg)]"
        >
          {retryLabel}
        </button>
        {backHref && (
          <Link href={backHref} className="text-[13px] text-[var(--studio-accent)] hover:underline">
            {backLabel}
          </Link>
        )}
      </div>
    </div>
  );
}
