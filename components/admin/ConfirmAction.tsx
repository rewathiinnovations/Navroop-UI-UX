'use client';

import { ReactNode, useEffect, useId, useState } from 'react';
import StudioButton from '@/components/app/studio/StudioButton';
import StudioModal from '@/components/ui/StudioModal';

/**
 * One confirmation dialog for destructive actions.
 *
 * The product previously had four mechanisms — a raw `window.confirm`, a
 * bespoke type-to-confirm modal, a second bespoke type-to-confirm modal, and
 * nothing at all. Deactivating a member, abandoning a running job, deleting a
 * project, deleting a workspace skill and removing an API key all fired on a
 * single click.
 *
 * Pass `confirmPhrase` for actions that are hard to undo; the confirm button
 * stays disabled until the phrase is typed exactly.
 *
 * `ConfirmDialog` is the controlled half, for callers whose trigger is not a
 * button they own — a `DropdownMenuItem`, a table row, an existing toolbar
 * button. `ConfirmAction` is the same dialog with its own trigger button.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel = 'Confirm',
  confirmPhrase,
  onConfirm,
  busyLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  confirmPhrase?: string;
  /**
   * Receives the phrase the user actually typed, for endpoints that re-check it
   * server-side. Throw to keep the dialog open and show the message inside it.
   */
  onConfirm: (confirmedPhrase: string) => Promise<void> | void;
  busyLabel?: string;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Not derived from the title: `TemplatesAdmin` renders one Accordion per row
  // and the same class of bug was live there (F-408). Ids are per instance.
  const phraseId = useId();

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
      await onConfirm(typed.trim());
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <StudioModal
      open={open}
      onOpenChange={onOpenChange}
      dismissible={!busy}
      title={title}
      titleClassName="text-[16px] font-medium text-[var(--studio-fg)]"
      className="studio-pop-in relative z-10 w-full max-w-[440px] rounded-16 border border-[var(--studio-line)] bg-[var(--studio-surface)] p-24 shadow-[var(--studio-shadow-pop)]"
    >
      <div className="mt-8 text-[14px] leading-6 text-[var(--studio-muted)]">{body}</div>

      {confirmPhrase && (
        <div className="mt-16 space-y-8">
          <label htmlFor={phraseId} className="block text-[13px] text-[var(--studio-fg)]">
            Type <span className="font-medium">{confirmPhrase}</span> to continue
          </label>
          <input
            id={phraseId}
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
          onClick={() => onOpenChange(false)}
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
    </StudioModal>
  );
}

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
  triggerClassName,
}: {
  label: ReactNode;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  confirmPhrase?: string;
  onConfirm: (confirmedPhrase: string) => Promise<void> | void;
  disabled?: boolean;
  variant?: 'danger' | 'ghost' | 'primary' | 'inverted';
  busyLabel?: string;
  /** Styles the trigger button so dense rows can keep their compact pills. */
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <StudioButton
        type="button"
        variant={variant}
        disabled={disabled}
        className={triggerClassName}
        onClick={() => setOpen(true)}
      >
        {label}
      </StudioButton>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        body={body}
        confirmLabel={confirmLabel}
        confirmPhrase={confirmPhrase}
        onConfirm={onConfirm}
        busyLabel={busyLabel}
      />
    </>
  );
}
