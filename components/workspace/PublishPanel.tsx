'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Copy, ExternalLink, Loader2, X } from 'lucide-react';
import { cn } from '@/utils/cn';
import Hint from './Hint';
import RecoveryPanel from './RecoveryPanel';
import { isPublishRunning, type PublicGenerationJob } from '@/lib/jobs/types';
import { PUBLISH_STEPPER, stepperIndex, type PublishStepKey } from '@/lib/publish/steps';
import type { PublicDeployment } from '@/lib/publish/serialize';

type PublishState = {
  canPublish: boolean;
  hasFiles?: boolean;
  isAdmin?: boolean;
  missingIntegrations?: string[];
  setupMessage?: string | null;
  previewUrl: string;
  liveUrl: string;
  deployments: PublicDeployment[];
  job?: PublicGenerationJob | null;
};

function formatWhen(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

function stepStatus(current: string | null | undefined, status: string, keys: readonly PublishStepKey[]) {
  if (status === 'LIVE' && keys.includes('live')) return 'done';
  if (!current) return 'pending';
  const currentIndex = stepperIndex(current);
  const rowIndex = PUBLISH_STEPPER.findIndex((row) => row.keys === keys || row.keys.some((key) => keys.includes(key)));
  if (status === 'FAILED' && rowIndex === currentIndex) return 'failed';
  if (rowIndex < currentIndex) return 'done';
  if (rowIndex === currentIndex) return status === 'LIVE' ? 'done' : 'running';
  return 'pending';
}

export default function PublishPanel({
  projectId,
  canPublishHint = 'Generate the project first',
}: {
  projectId?: string | null;
  canPublishHint?: string;
}) {
  const [openMenu, setOpenMenu] = useState(false);
  const [sheetKind, setSheetKind] = useState<'PREVIEW' | 'LIVE' | null>(null);
  const [state, setState] = useState<PublishState | null>(null);
  const [busy, setBusy] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [password, setPassword] = useState('');
  const [copied, setCopied] = useState(false);
  const [limitError, setLimitError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const deployment = useMemo(
    () => state?.deployments.find((row) => row.kind === sheetKind) ?? null,
    [state, sheetKind],
  );

  const load = async () => {
    if (!projectId) return;
    const response = await fetch(`/api/projects/${projectId}/publish`);
    const data = (await response.json().catch(() => ({}))) as PublishState & { error?: string };
    if (response.ok) setState(data);
  };

  useEffect(() => {
    void load();
  }, [projectId]);

  useEffect(() => {
    if (!openMenu) return;
    const onPointer = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpenMenu(false);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [openMenu]);

  useEffect(() => {
    if (!sheetKind || !projectId) return;
    const inFlight = isPublishRunning(state?.job ?? null) || deployment?.status === 'QUEUED' || deployment?.status === 'BUILDING';
    if (!inFlight) return;
    const timer = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(timer);
  }, [sheetKind, projectId, deployment?.status, deployment?.progressStep, state?.job?.status, state?.job?.currentStep]);

  useEffect(() => {
    if (!startedAt) return;
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  useEffect(() => {
    if (isPublishRunning(state?.job ?? null) || deployment?.status === 'QUEUED' || deployment?.status === 'BUILDING') {
      setStartedAt((current) => current ?? Date.now());
    }
    if (!isPublishRunning(state?.job ?? null) && (deployment?.status === 'LIVE' || deployment?.status === 'FAILED' || state?.job?.status === 'ABANDONED')) {
      setStartedAt(null);
    }
  }, [deployment?.status, state?.job]);

  const canPublish = Boolean(state?.canPublish && projectId);
  const setupMessage = state?.setupMessage || null;
  const publishHint = setupMessage || canPublishHint;
  const expectedUrl = sheetKind === 'LIVE' ? state?.liveUrl : state?.previewUrl;
  const liveCanonical = state?.deployments.find((row) => row.kind === 'LIVE')?.canonicalUrl;
  const publicUrl = sheetKind === 'LIVE' && liveCanonical ? liveCanonical : expectedUrl;

  const start = async (kind: 'PREVIEW' | 'LIVE') => {
    if (!projectId || !canPublish) return;
    setSheetKind(kind);
    setOpenMenu(false);
    setBusy(true);
    setStartedAt(Date.now());
    setElapsed(0);
    setLimitError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) setState(data as PublishState);
      else if (response.status === 409 && (data.code === 'PROJECT_LOCKED' || data.heldBy)) {
        const { emitLockConflict, parseLockConflict } = await import('@/lib/projects/lock-client');
        const conflict = parseLockConflict(409, data);
        if (conflict) emitLockConflict(conflict);
      }
      else if (response.status === 402) {
        setLimitError(typeof data.message === 'string' ? data.message : 'Plan limit is used up — talk to an admin');
      } else await load();
    } finally {
      setBusy(false);
    }
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  const savePassword = async (next: string | null) => {
    if (!projectId) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/publish/password`, {
        method: next ? 'POST' : 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: next }),
      });
      if (response.ok) {
        const data = (await response.json()) as PublishState;
        setState(data);
        setPassword('');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="relative" ref={menuRef} data-tour="publish">
        <Hint label={canPublish ? 'Publish' : publishHint}>
          <button
            type="button"
            disabled={!canPublish}
            onClick={() => setOpenMenu((value) => !value)}
            className="inline-flex h-32 items-center gap-4 rounded-full bg-[var(--studio-fg)] px-14 text-[13px] font-medium text-[var(--studio-bg)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Publish
            <ChevronDown className="size-14" />
          </button>
        </Hint>
        {openMenu && (
          <div className="absolute right-0 z-40 mt-8 w-[220px] overflow-hidden rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] shadow-sm">
            <button
              type="button"
              className="flex w-full px-14 py-12 text-left text-[13px] text-[var(--studio-fg)] hover:bg-[var(--studio-surface-hover)]"
              onClick={() => void start('PREVIEW')}
            >
              Create preview link
            </button>
            <button
              type="button"
              className="flex w-full px-14 py-12 text-left text-[13px] text-[var(--studio-fg)] hover:bg-[var(--studio-surface-hover)]"
              onClick={() => void start('LIVE')}
            >
              Go live
            </button>
          </div>
        )}
      </div>

      {sheetKind && (
        <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[400px] flex-col border-l border-[var(--studio-line)] bg-[var(--studio-surface)] shadow-[-16px_0_40px_rgba(24,24,27,0.08)]">
          <div className="flex items-center justify-between border-b border-[var(--studio-line)] px-16 py-14">
            <div>
              <p className="text-[15px] font-medium text-[var(--studio-fg)]">
                {sheetKind === 'LIVE' ? 'Live publish' : 'Preview publish'}
              </p>
              <p className="mt-2 text-[12px] text-[var(--studio-muted)]">{publicUrl}</p>
            </div>
            <button
              type="button"
              aria-label="Close publish panel"
              onClick={() => setSheetKind(null)}
              className="inline-flex size-36 items-center justify-center rounded-10 text-[var(--studio-muted)] hover:bg-[var(--studio-surface-hover)]"
            >
              <X className="size-16" />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-16 py-16">
            {setupMessage && (
              <div className="mb-16 rounded-12 border border-[var(--studio-line)] p-12">
                <p className="text-[13px] text-[var(--studio-fg)]">{setupMessage}</p>
                {state?.isAdmin ? (
                  <a href="/admin/integrations" className="mt-8 inline-block text-[13px] text-[var(--studio-accent)]">
                    /admin/integrations
                  </a>
                ) : (
                  <p className="mt-8 text-[13px] text-[var(--studio-muted)]">Ask an admin to finish setup</p>
                )}
              </div>
            )}
            {deployment?.status === 'LIVE' && deployment.url ? (
              <div className="space-y-16">
                <a
                  href={deployment.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block break-all text-[20px] font-medium text-[var(--studio-accent)] hover:underline"
                >
                  {deployment.url}
                </a>
                <div className="flex gap-8">
                  <button
                    type="button"
                    onClick={() => void copy(deployment.url!)}
                    className="inline-flex h-36 items-center gap-6 rounded-full border border-[var(--studio-line-strong)] px-12 text-[13px]"
                  >
                    {copied ? <Check className="size-14" /> : <Copy className="size-14" />}
                    Copy
                  </button>
                  <a
                    href={deployment.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-36 items-center gap-6 rounded-full bg-[var(--studio-fg)] px-12 text-[13px] text-[var(--studio-bg)]"
                  >
                    <ExternalLink className="size-14" />
                    Open
                  </a>
                </div>
                <p className="text-[12px] text-[var(--studio-muted)]">
                  Last published {formatWhen(deployment.publishedAt)}
                  {deployment.publishedBy ? ` · ${deployment.publishedBy.name}` : ''}
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void start(sheetKind)}
                  className="inline-flex h-36 items-center rounded-full border border-[var(--studio-line-strong)] px-14 text-[13px]"
                >
                  Publish again
                </button>
                {sheetKind === 'PREVIEW' && (
                  <div className="space-y-8 rounded-12 border border-[var(--studio-line)] p-12">
                    <p className="text-[13px] text-[var(--studio-muted)]">
                      This link will not appear in search engines
                    </p>
                    <input
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder={deployment.hasPassword ? 'New password' : 'Preview password'}
                      className="h-40 w-full rounded-10 border border-[var(--studio-line)] px-10 text-[13px]"
                    />
                    <div className="flex gap-8">
                      <button
                        type="button"
                        disabled={busy || !password.trim()}
                        onClick={() => void savePassword(password.trim())}
                        className="text-[13px] font-medium text-[var(--studio-accent)]"
                      >
                        {deployment.hasPassword ? 'Change password' : 'Set password'}
                      </button>
                      {deployment.hasPassword && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void savePassword(null)}
                          className="text-[13px] text-[var(--studio-danger)]"
                        >
                          Remove password
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-16">
                <p className="text-[13px] text-[var(--studio-muted)]">
                  URL: <span className="text-[var(--studio-fg)]">{publicUrl}</span>
                </p>
                <p className="text-[12px] text-[var(--studio-faint)]">
                  {startedAt ? `${elapsed}s` : ''}
                </p>
                {state?.job && (state.job.status === 'ABANDONED' || state.job.status === 'FAILED') ? (
                  <RecoveryPanel
                    variant="publish"
                    kind={state.job.kind}
                    errorCode={state.job.errorCode}
                    errorMessage={state.job.errorMessage}
                    filesWritten={0}
                    requestId={state.job.requestId}
                    steps={state.job.steps}
                    compensation={state.job.resourceIds?.compensation ?? null}
                    resourceIds={state.job.resourceIds}
                    liveUrl={deployment?.url}
                    buildLogUrl={deployment?.buildLogUrl}
                    onRetry={() => void start(sheetKind)}
                  />
                ) : null}
                <ol className="space-y-10">
                  {PUBLISH_STEPPER.map((row) => {
                    const jobStep = state?.job?.steps?.find((step) => row.keys.includes(step.key as PublishStepKey));
                    const current = state?.job?.currentStep || deployment?.progressStep;
                    const status = jobStep?.status === 'failed'
                      ? 'failed'
                      : jobStep?.status === 'succeeded'
                        ? 'done'
                        : jobStep?.status === 'running'
                          ? 'running'
                          : stepStatus(current, isPublishRunning(state?.job ?? null) ? 'BUILDING' : deployment?.status ?? 'QUEUED', row.keys);
                    return (
                      <li key={row.label} className="flex items-start gap-10">
                        <span
                          className={cn(
                            'mt-2 size-10 shrink-0 rounded-full',
                            status === 'done' && 'bg-emerald-500',
                            status === 'running' && 'bg-[var(--studio-accent)]',
                            status === 'failed' && 'bg-[var(--studio-danger)]',
                            status === 'pending' && 'bg-[var(--studio-line)]',
                          )}
                        />
                        <div>
                          <p
                            className={cn(
                              'text-[13px]',
                              status === 'failed' ? 'font-medium text-[var(--studio-danger)]' : 'text-[var(--studio-fg)]',
                            )}
                          >
                            {row.label}
                          </p>
                          {status === 'running' && <Loader2 className="mt-4 size-14 animate-spin text-[var(--studio-muted)]" />}
                        </div>
                      </li>
                    );
                  })}
                </ol>
                {limitError && (
                  <div className="space-y-8 rounded-12 border border-[var(--studio-danger)]/30 p-12">
                    <p className="text-[13px] text-[var(--studio-danger)]">{limitError}</p>
                    <p className="text-[13px] text-[var(--studio-muted)]">Talk to an admin</p>
                  </div>
                )}
                {deployment?.status === 'FAILED' && (
                  <div className="space-y-8 rounded-12 border border-[var(--studio-danger)]/30 p-12">
                    <p className="text-[13px] text-[var(--studio-danger)]">{deployment.lastError}</p>
                    {deployment.lastRequestId && (
                      <p className="text-[11px] text-[var(--studio-faint)]">Request {deployment.lastRequestId}</p>
                    )}
                    {deployment.buildLogUrl && (
                      <a href={deployment.buildLogUrl} target="_blank" rel="noreferrer" className="text-[13px] text-[var(--studio-accent)]">
                        View build log
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => void start(sheetKind)}
                      className="inline-flex h-36 items-center rounded-full bg-[var(--studio-fg)] px-14 text-[13px] text-[var(--studio-bg)]"
                    >
                      Try again
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </aside>
      )}
    </>
  );
}
