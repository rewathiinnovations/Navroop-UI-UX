'use client';

import AdminPage from '@/components/admin/AdminPage';
import ConfirmAction from '@/components/admin/ConfirmAction';
import { FormEvent, useState } from 'react';
import StudioButton from '@/components/app/studio/StudioButton';
import StudioField from '@/components/app/studio/StudioField';
import { fetchJson, notify } from '@/lib/notify';

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
  // Per-field, not one shared flag: saving the cap must not disable the spend
  // limit, and the pause switch is unrelated to both.
  const [savingCap, setSavingCap] = useState(false);
  const [savingSpendLimit, setSavingSpendLimit] = useState(false);
  const [savingPause, setSavingPause] = useState(false);

  const saveCap = async (event: FormEvent) => {
    event.preventDefault();
    setSavingCap(true);
    try {
      await fetchJson('/api/admin/workspace', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memberMonthlyCreditCap: cap.trim() === '' ? null : Number(cap),
        }),
      });
      notify.success('Member cap saved.', { key: 'workspace-cap' });
    } catch (error) {
      notify.error(error, { fallback: 'Could not save', key: 'workspace-cap' });
    } finally {
      setSavingCap(false);
    }
  };

  const saveSpendLimit = async (event: FormEvent) => {
    event.preventDefault();
    setSavingSpendLimit(true);
    try {
      await fetchJson('/api/admin/workspace', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          monthlySpendLimitUsd: spendLimit.trim() === '' ? null : Number(spendLimit),
        }),
      });
      notify.success('Spend limit saved.', { key: 'workspace-spend-limit' });
    } catch (error) {
      notify.error(error, { fallback: 'Could not save', key: 'workspace-spend-limit' });
    } finally {
      setSavingSpendLimit(false);
    }
  };

  // Pausing is confirmed by ConfirmAction on the button; resuming is one click.
  const togglePause = async () => {
    setSavingPause(true);
    try {
      const payload = await fetchJson<{ generationPaused?: boolean; pauseReason?: string | null }>(
        '/api/admin/workspace',
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ generationPaused: !paused }),
        },
      );
      setPaused(Boolean(payload.generationPaused));
      setPauseReason(payload.pauseReason ?? null);
      if (payload.generationPaused) {
        notify.warning('Generation paused for the whole workspace.', { key: 'workspace-pause' });
      } else {
        notify.success('Generation resumed.', { key: 'workspace-pause' });
      }
    } catch (error) {
      notify.error(error, { fallback: 'Could not update pause', key: 'workspace-pause' });
    } finally {
      setSavingPause(false);
    }
  };

  return (
    <AdminPage
      icon="workspace"
      title="Workspace"
      description="Spending caps for the whole workspace, and the switch that stops all generation at once."
    >
      {/* Two forms, not one. A single `<form onSubmit={saveCap}>` around both
          fields meant Enter inside the spend limit ran `saveCap` — which PATCHes
          `memberMonthlyCreditCap` only — and then toasted "Member cap saved."
          while the edited spend ceiling was dropped. */}
      <form onSubmit={saveCap} className="space-y-16">
        <StudioField
          id="member-cap"
          label="Member monthly credit cap"
          type="number"
          value={cap}
          onChange={(event) => setCap(event.target.value)}
          placeholder="Empty = no per-member cap"
        />
        <StudioButton type="submit" variant="primary" disabled={savingCap}>
          {savingCap ? 'Saving…' : 'Save cap'}
        </StudioButton>
      </form>

      <form onSubmit={saveSpendLimit} className="mt-24 space-y-16">
        <StudioField
          id="spend-limit"
          label="Monthly spend limit (USD)"
          type="number"
          value={spendLimit}
          onChange={(event) => setSpendLimit(event.target.value)}
          placeholder="Empty = no spend ceiling"
        />
        <StudioButton type="submit" variant="ghost" disabled={savingSpendLimit}>
          {savingSpendLimit ? 'Saving…' : 'Save spend limit'}
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
            disabled={savingPause}
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
            disabled={savingPause}
            onConfirm={() => togglePause()}
          />
        )}
      </div>

      {initial.creditAlert80Sent && (
        <p className="mt-24 text-[13px] text-[var(--studio-muted)]">
          80% credit alert already sent this period.
        </p>
      )}
    </AdminPage>
  );
}
