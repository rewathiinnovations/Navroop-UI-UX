'use client';

import { useState } from 'react';

export default function ErrorId({
  requestId,
  message = 'Something went wrong. Try the page again.',
}: {
  requestId?: string | null;
  message?: string;
}) {
  const [copied, setCopied] = useState(false);
  if (!requestId) {
    return <p className="text-[13px] text-[var(--studio-muted)]">{message}</p>;
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(requestId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be blocked */
    }
  };

  return (
    <div className="space-y-8">
      <p className="text-[14px] text-[var(--studio-fg)]">{message}</p>
      <p className="text-[12px] text-[var(--studio-faint)]">
        Error ID: {requestId}
      </p>
      <div className="flex flex-wrap items-center gap-8">
        <button
          type="button"
          onClick={() => void copy()}
          className="text-[12px] text-[var(--studio-muted)] underline-offset-2 hover:underline"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <span className="text-[12px] text-[var(--studio-faint)]">Send this ID to support</span>
      </div>
    </div>
  );
}
