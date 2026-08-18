'use client';

import { ReactNode, useEffect, useState } from 'react';
import StudioButton from '@/components/app/studio/StudioButton';

/**
 * One confirmation dialog for destructive admin actions.
 *
 * Admin previously had three mechanisms — a raw `window.confirm`, a bespoke
 * type-to-confirm modal, and nothing at all. Deactivating a member and
 * abandoning a running job both fired on a single click.
 *
 * Pass `confirmPhrase` for actions that are hard to undo; the confirm button
 * stays disabled until the phrase is typed exactly.
 */
export default function ConfirmAction({
  label,
  title,
  body,
  confirmLabel = 'Confirm',
  confirmPhrase,
  onConfirm,
  disabled,
  variant = 'danger',
  busyLabel,
}: {
  label: ReactNode;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  confirmPhrase?: string;
  onConfirm: () => Promise<void> | void;
  disabled?: boolean;
  variant?: 'danger' | 'ghost' | 'primary' | 'inverted';
  busyLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, busy]);

  useEffect(() => {
    if (open) {
      setTyped('');
      setError(null);
    }
  }, [open]);

  const phraseOk = !confirmPhrase || typed.trim() === confirmPhrase;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <StudioButton
        type="button"
        variant={variant}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {label}
      </StudioButton>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-20">
          <button
            type="button"
            aria-label="Cancel"
            disabled={busy}
            className="absolute inset-0 bg-[var(--studio-fg)]/20"
            onClick={() => setOpen(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-action-title"
            className="relative z-10 w-full max-w-[440px] rounded-16 border border-[var(--studio-line)] bg-[var(--studio-surface)] p-24 shadow-lg"
          >
            <h2
              id="confirm-action-title"
              className="text-[16px] font-medium text-[var(--studio-fg)]"
            >
              {title}
            </h2>
            <div className="mt-8 text-[14px] leading-6 text-[var(--studio-muted)]">{body}</div>

            {confirmPhrase && (
              <div className="mt-16 space-y-8">
                <label
                  htmlFor="confirm-action-phrase"
                  className="block text-[13px] text-[var(--studio-fg)]"
                >
                  Type <span className="font-medium">{confirmPhrase}</span> to continue
                </label>
                <input
                  id="confirm-action-phrase"
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  autoComplete="off"
                  className="h-40 w-full rounded-10 border border-[var(--studio-line-strong)] bg-[var(--studio-bg)] px-12 text-[14px] text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
                />
              </div>
            )}

            {error && (
              <p className="mt-12 text-[13px] text-[var(--studio-danger)]" role="alert">
                {error}
              </p>
            )}

            <div className="mt-20 flex justify-end gap-8">
              <StudioButton
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                Cancel
              </StudioButton>
              <StudioButton
                type="button"
                variant="danger"
                disabled={busy || !phraseOk}
                onClick={() => {
                  void run();
                }}
              >
                {busy ? busyLabel || 'Working…' : confirmLabel}
              </StudioButton>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
