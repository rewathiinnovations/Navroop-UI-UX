'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect, useMemo } from 'react';
import ErrorId from '@/components/errors/ErrorId';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const requestId = useMemo(
    () => (error.digest ? error.digest.slice(0, 12) : crypto.randomUUID().replace(/-/g, '').slice(0, 12)),
    [error.digest],
  );

  useEffect(() => {
    Sentry.captureException(error, { tags: { requestId } });
  }, [error, requestId]);

  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, background: '#fafafa', color: '#18181b' }}>
        <main style={{ maxWidth: 520, margin: '0 auto', padding: '80px 20px' }}>
          <h1 style={{ fontSize: 24, fontWeight: 500, marginBottom: 12 }}>Page failed to load</h1>
          <ErrorId requestId={requestId} message="Something went wrong. Reload the page." />
          <button
            type="button"
            onClick={() => reset()}
            style={{ marginTop: 20, background: 'none', border: 0, color: '#2563eb', cursor: 'pointer' }}
          >
            Reload the page
          </button>
          {process.env.NODE_ENV !== 'production' && error.message ? (
            <p style={{ marginTop: 16, fontSize: 12, color: '#71717a' }}>{error.message}</p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
