'use client';

import {
  filesWrittenLabel,
  keepActionLabel,
  PUBLISH_KEPT_LIVE_LINE,
  PUBLISH_ROLLBACK_LINE,
  recoveryCauseLine,
  recoveryHeading,
  START_OVER_LABEL,
  TRY_AGAIN_LABEL,
} from '@/lib/jobs/copy';
import { sandboxChoiceLines } from '@/lib/jobs/sandbox-choice';
import type { JobResourceIds, JobStep } from '@/lib/jobs/types';

export default function RecoveryPanel({
  errorCode,
  filesWritten,
  requestId,
  busy,
  onKeep,
  onRetry,
  onStartOver,
  offerRetry = true,
  nextStep,
  variant = 'generation',
  kind,
  steps,
  compensation,
  liveUrl,
  buildLogUrl,
  resourceIds,
}: {
  errorCode?: string | null;
  filesWritten: number;
  requestId?: string | null;
  busy?: string | null;
  onKeep?: () => void;
  onRetry?: () => void;
  onStartOver?: () => void;
  offerRetry?: boolean;
  nextStep?: string | null;
  variant?: 'generation' | 'publish';
  kind?: string | null;
  steps?: JobStep[] | null;
  compensation?: 'rolled_back' | 'kept_live' | null;
  liveUrl?: string | null;
  buildLogUrl?: string | null;
  resourceIds?: JobResourceIds | null;
}) {
  const heading = recoveryHeading(kind ?? (variant === 'publish' ? 'PUBLISH' : 'BUILD'));
  const cause = recoveryCauseLine(errorCode);
  const failedKey = steps?.find((step) => step.status === 'failed')?.key;
  const sandboxLines = sandboxChoiceLines(resourceIds);

  return (
    <div
      role="status"
      className="mb-16 rounded-16 border border-[var(--studio-line)] bg-[var(--studio-bg)] px-14 py-12"
    >
      <p className="text-[14px] font-medium text-[var(--studio-fg)]">{heading}</p>
      {cause ? <p className="mt-4 text-[13px] text-[var(--studio-muted)]">{cause}</p> : null}
      {nextStep ? <p className="mt-4 text-[13px] text-[var(--studio-muted)]">{nextStep}</p> : null}
      {sandboxLines.length > 0 ? (
        <ul className="mt-8 space-y-4 text-[13px] text-[var(--studio-muted)]">
          {sandboxLines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {variant === 'publish' && steps && steps.length > 0 ? (
        <ol className="mt-10 space-y-6">
          {steps.map((step) => (
            <li
              key={step.key}
              className={
                step.key === failedKey || step.status === 'failed'
                  ? 'text-[13px] font-medium text-[var(--studio-danger)]'
                  : 'text-[13px] text-[var(--studio-muted)]'
              }
            >
              {step.label}
            </li>
          ))}
        </ol>
      ) : null}
      {variant === 'publish' && compensation === 'rolled_back' ? (
        <p className="mt-8 text-[13px] text-[var(--studio-muted)]">{PUBLISH_ROLLBACK_LINE}</p>
      ) : null}
      {variant === 'publish' && compensation === 'kept_live' ? (
        <p className="mt-8 text-[13px] text-[var(--studio-muted)]">
          {PUBLISH_KEPT_LIVE_LINE}
          {liveUrl ? (
            <>
              {' '}
              <a href={liveUrl} target="_blank" rel="noreferrer" className="text-[var(--studio-accent)]">
                {liveUrl}
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      {filesWritten > 0 && kind !== 'IMPORT' && kind !== 'PLAN' ? (
        <p className="mt-4 text-[13px] text-[var(--studio-muted)]">{filesWrittenLabel(filesWritten)}</p>
      ) : null}
      <div className="mt-12 flex flex-wrap gap-8">
        {filesWritten > 0 && onKeep && kind !== 'IMPORT' && kind !== 'PLAN' ? (
          <button
            type="button"
            onClick={onKeep}
            disabled={Boolean(busy)}
            className="rounded-10 bg-[var(--studio-fg)] px-12 py-8 text-[13px] font-medium text-[var(--studio-bg)] disabled:opacity-40"
          >
            {busy === 'keep' ? 'Saving…' : keepActionLabel(kind)}
          </button>
        ) : null}
        {offerRetry && onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            disabled={Boolean(busy)}
            className="rounded-10 border border-[var(--studio-line-strong)] px-12 py-8 text-[13px] font-medium text-[var(--studio-fg)] disabled:opacity-40"
          >
            {busy === 'retry' ? 'Starting…' : TRY_AGAIN_LABEL}
          </button>
        ) : null}
        {onStartOver ? (
          <button
            type="button"
            onClick={onStartOver}
            disabled={Boolean(busy)}
            className="rounded-10 px-12 py-8 text-[13px] text-[var(--studio-muted)] hover:text-[var(--studio-fg)] disabled:opacity-40"
          >
            {START_OVER_LABEL}
          </button>
        ) : null}
      </div>
      {buildLogUrl ? (
        <a
          href={buildLogUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-10 inline-block text-[13px] text-[var(--studio-accent)]"
        >
          View build log
        </a>
      ) : null}
      {requestId ? (
        <p className="mt-10 text-[11px] text-[var(--studio-faint)]">Request id: {requestId}</p>
      ) : null}
    </div>
  );
}
