'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect, useMemo } from 'react';
import ErrorId from '@/components/errors/ErrorId';
import { errorRequestId } from '@/lib/errors/request-id';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const requestId = useMemo(() => errorRequestId(error.digest), [error.digest]);

  useEffect(() => {
    // F-436: this boundary catches the common case — a page or nested segment
    // throwing during render — and used to log only to this browser's console.
    // `ErrorId` tells the user to send the id to support, so support has to be
    // able to look it up. `global-error.tsx` already reports the rarer
    // root-layout throw the same way.
    Sentry.captureException(error, { tags: { requestId } });
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        event: 'ui.app.error',
        requestId,
        error: error.message,
        stack: process.env.NODE_ENV === 'production' ? undefined : error.stack,
      }),
    );
  }, [error, requestId]);

  return (
    <main className="mx-auto flex min-h-[50vh] max-w-[520px] flex-col justify-center px-20 py-40">
      <h1 className="mb-12 text-[24px] font-medium tracking-[-0.03em] text-[var(--studio-fg,#18181b)]">
        Page failed to load
      </h1>
      <ErrorId requestId={requestId} message="Something went wrong. Reload the page." />
      <button
        type="button"
        onClick={() => reset()}
        className="mt-20 self-start text-[13px] text-[var(--studio-accent,#2563eb)] underline-offset-2 hover:underline"
      >
        Reload the page
      </button>
    </main>
  );
}
