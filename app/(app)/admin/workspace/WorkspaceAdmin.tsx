'use client';

import AdminPage from '@/components/admin/AdminPage';
import ConfirmAction from '@/components/admin/ConfirmAction';
import { FormEvent, useState } from 'react';
import StudioButton from '@/components/app/studio/StudioButton';
import StudioField from '@/components/app/studio/StudioField';

export default function WorkspaceAdmin({
  initial,
}: {
  initial: {
    memberMonthlyCreditCap: number | null;
    generationPaused: boolean;
    creditAlert80Sent: boolean;
    pauseReason?: string | null;
    monthlySpendLimitUsd?: number | null;
    spendUsd?: number;
  };
}) {
  const [cap, setCap] = useState(initial.memberMonthlyCreditCap?.toString() ?? '');
  const [spendLimit, setSpendLimit] = useState(initial.monthlySpendLimitUsd?.toString() ?? '');
  const [paused, setPaused] = useState(initial.generationPaused);
  const [pauseReason, setPauseReason] = useState(initial.pauseReason ?? null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const saveCap = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/admin/workspace', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memberMonthlyCreditCap: cap.trim() === '' ? null : Number(cap),
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error || 'Could not save');
        return;
      }
      setMessage('Member cap saved.');
    } finally {
      setBusy(false);
    }
  };

  // Pausing is confirmed by ConfirmAction on the button; resuming is one click.
  const togglePause = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/admin/workspace', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ generationPaused: !paused }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error || 'Could not update pause');
        return;
      }
      setPaused(Boolean(payload.generationPaused));
      setPauseReason(payload.pauseReason ?? null);
      setMessage(payload.generationPaused ? 'Generation paused.' : 'Generation resumed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AdminPage
      icon="workspace"
      title="Workspace"
      description="Spending caps for the whole workspace, and the switch that stops all generation at once."
    >
      <form onSubmit={saveCap} className="space-y-16">
        <StudioField
          id="member-cap"
          label="Member monthly credit cap"
          type="number"
          value={cap}
          onChange={(event) => setCap(event.target.value)}
          placeholder="Empty = no per-member cap"
        />
        <StudioField
          id="spend-limit"
          label="Monthly spend limit (USD)"
          type="number"
          value={spendLimit}
          onChange={(event) => setSpendLimit(event.target.value)}
          placeholder="Empty = no spend ceiling"
        />
        <StudioButton
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            void (async () => {
              setBusy(true);
              setError('');
              setMessage('');
              try {
                const response = await fetch('/api/admin/workspace', {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    monthlySpendLimitUsd: spendLimit.trim() === '' ? null : Number(spendLimit),
                  }),
                });
                const payload = await response.json();
                if (!response.ok) {
                  setError(payload.error || 'Could not save');
                  return;
                }
                setMessage('Spend limit saved.');
              } finally {
                setBusy(false);
              }
            })();
          }}
        >
          Save spend limit
        </StudioButton>
        <StudioButton type="submit" variant="primary" disabled={busy}>
          Save cap
        </StudioButton>
      </form>

      <div className="mt-32 space-y-12">
        <h2 className="text-[18px] font-medium text-[var(--studio-fg)]">Emergency pause</h2>
        <p className="text-[13px] text-[var(--studio-muted)]">
          {paused
            ? pauseReason === 'SPEND_LIMIT'
              ? 'Automatic pause — this workspace reached its spend limit.'
              : 'Manual pause — generation is paused for the whole workspace.'
            : 'Generation is running. Pause to block all credit-consuming actions.'}
        </p>
        {typeof initial.spendUsd === 'number' && (
          <p className="text-[12px] text-[var(--studio-faint)]">
            Spend this period: ${initial.spendUsd.toFixed(2)}
            {initial.monthlySpendLimitUsd != null
              ? ` / $${initial.monthlySpendLimitUsd.toFixed(2)}`
              : ''}
          </p>
        )}
        {paused ? (
          <StudioButton
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => void togglePause()}
          >
            Resume generation
          </StudioButton>
        ) : (
          <ConfirmAction
            label="Pause generation"
            title="Pause all generation?"
            body="Every credit-consuming action stops immediately for the whole workspace, including builds already queued. Members see generation as paused until an admin resumes it."
            confirmLabel="Pause generation"
            busyLabel="Pausing…"
            disabled={busy}
            onConfirm={() => togglePause()}
          />
        )}
      </div>

      {initial.creditAlert80Sent && (
        <p className="mt-24 text-[13px] text-[var(--studio-muted)]">
          80% credit alert already sent this period.
        </p>
      )}
      {error && (
        <p className="mt-16 text-[13px] text-[var(--studio-danger)]" role="alert">
          {error}
        </p>
      )}
      {message && <p className="mt-16 text-[13px] text-[var(--studio-muted)]">{message}</p>}
    </AdminPage>
  );
}
