'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { TERMS_REQUIRED_MESSAGE } from '@/lib/legal/terms';

export default function TermsGate() {
  const [needed, setNeeded] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void fetch('/api/legal/accept')
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (data && !data.termsAcceptedAt) setNeeded(true);
      })
      .catch(() => undefined);
  }, []);

  if (!needed) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 px-16">
      <form
        className="w-full max-w-[400px] rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] p-20"
        onSubmit={async (event) => {
          event.preventDefault();
          setError('');
          if (!accepted) {
            setError(TERMS_REQUIRED_MESSAGE);
            return;
          }
          setSaving(true);
          try {
            const response = await fetch('/api/legal/accept', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ acceptTerms: true }),
            });
            if (!response.ok) {
              const data = await response.json().catch(() => ({}));
              setError(String(data.error || TERMS_REQUIRED_MESSAGE));
              return;
            }
            setNeeded(false);
          } finally {
            setSaving(false);
          }
        }}
      >
        <h2 className="text-[18px] font-medium text-[var(--studio-fg)]">Agree to continue</h2>
        <p className="mt-8 text-[13px] leading-5 text-[var(--studio-muted)]">
          Invited accounts must accept the Terms and Privacy Policy before using the studio.
        </p>
        <label className="mt-16 flex items-start gap-10 text-[13px] leading-5 text-[var(--studio-fg)]">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(event) => setAccepted(event.target.checked)}
            className="mt-2 size-16"
          />
          <span>
            I agree to the{' '}
            <Link href="/terms" className="underline" target="_blank">
              Terms
            </Link>{' '}
            and{' '}
            <Link href="/privacy" className="underline" target="_blank">
              Privacy Policy
            </Link>
          </span>
        </label>
        {error && (
          <p className="mt-10 text-[13px] text-[var(--studio-danger)]" role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={saving}
          className="mt-16 inline-flex h-40 w-full items-center justify-center rounded-full bg-[var(--studio-fg)] text-[13px] font-medium text-[var(--studio-bg)]"
        >
          {saving ? 'Saving…' : 'Continue'}
        </button>
      </form>
    </div>
  );
}
