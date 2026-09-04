'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/utils/cn';
import {
  formatPreviewScale,
  getPreviewDevice,
  previewScale,
  rotateDeviceSize,
} from '@/lib/preview/devices';
import type { PreviewDeviceKey } from '@/lib/preview/devices';
import type { PlanTrigger, ProjectPhase, WorkspaceView } from './types';
import { previewPaneKind } from '@/lib/preview/after-generation';
import { EmptyState } from '@/components/shared/ui/empty-state';
import {
  LIVE_SANDBOX_LABEL,
  PREPARING_PREVIEW,
  PREVIEW_BUILD_FAILED,
  PREVIEW_EMPTY,
  PREVIEW_NOT_READY_NOTICE,
  STATIC_PREVIEW_LABEL,
} from '@/lib/preview/labels';

/**
 * Chrome around the preview: the device frame and the pane's empty/preparing
 * states. The frame itself belongs to the child.
 */
export default function PreviewPanel({
  children,
  sandboxUrl,
  hasFiles = false,
  expanded = false,
  previewDevice = 'desktop',
  previewRotated = false,
  view = 'preview',
  phase,
  planTrigger,
  planApproved = false,
  previewing = false,
  previewingLabel = null,
  heldBackLabel = null,
  onExitPreview,
  previewKind = 'static',
  preparingPreview = false,
  previewBuildFailed = false,
  previewBuildLog = null,
  onRetryPreview,
}: {
  children: ReactNode;
  sandboxUrl?: string | null;
  /** The project has code to render. Decides whether the pane is ready. */
  hasFiles?: boolean;
  expanded?: boolean;
  previewDevice?: PreviewDeviceKey;
  previewRotated?: boolean;
  view?: WorkspaceView;
  phase?: ProjectPhase | null;
  planTrigger?: PlanTrigger | null;
  /** The active plan's status is `APPROVED` — the reader has nothing left to approve. */
  planApproved?: boolean;
  previewing?: boolean;
  /** `v3`, when the version being previewed is known. Names it in the banner (F-102). */
  previewingLabel?: string | null;
  /**
   * The version on screen because the newest one does not build, e.g. `v7`.
   *
   * Distinct from {@link previewingLabel}: that one is a version the reader chose and can
   * leave, this one is the product refusing to render what they just asked for. There is no
   * "back to current" here on purpose — current is broken, and offering a button that puts a
   * non-working site on screen would be an affordance for making things worse.
   */
  heldBackLabel?: string | null;
  onExitPreview?: () => void;
  previewKind?: 'static' | 'live';
  preparingPreview?: boolean;
  previewBuildFailed?: boolean;
  previewBuildLog?: string | null;
  onRetryPreview?: () => void;
}) {
  const shellRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState({ width: 0, height: 0 });

  const pane = previewPaneKind({
    phase,
    planTrigger,
    hasFiles,
    previewUrl: sandboxUrl,
    preparing: preparingPreview,
    previewBuildFailed,
  });

  useEffect(() => {
    const node = shellRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      setAvailable({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const spec = getPreviewDevice(previewDevice);
  const frame =
    view === 'preview' && spec.width != null && spec.height != null
      ? previewRotated
        ? rotateDeviceSize(spec.width, spec.height)
        : { width: spec.width, height: spec.height }
      : null;
  const pad = frame ? 32 : 0;
  const scale = frame
    ? Math.min(
        previewScale(Math.max(0, available.width - pad), frame.width),
        previewScale(Math.max(0, available.height - pad), frame.height),
      )
    : 1;
  const scaleLabel = formatPreviewScale(scale);

  const showEmptyPlan = pane === 'planning';

  return (
    <div
      data-tour="preview"
      className={cn(
        'relative flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--studio-bg)]',
        expanded && 'flex-[1.4]',
      )}
    >
      {/*
       * A "Live mode" banner used to sit here, set by clicking one of three
       * "Turn on Live mode" buttons that could no longer do anything: live mode
       * was a sandbox VM, and `20260819010000_drop_sandbox_columns` deleted that
       * subsystem, so it is gone until someone re-architects it rather than
       * temporarily unavailable. A control whose only effect is to announce that
       * it cannot work is the same lying affordance as the 400 it replaced, so
       * both the buttons and the banner are gone. Do not re-add them without a
       * server that can actually serve a live preview.
       */}
      {/*
       * F-102: the banner is driven by `Project.previewingCheckpointId` now, so it is still
       * here after a reload. It used to be client-only state over a preview that had
       * overwritten `Project.lastCode` — reload and the warning vanished while the project
       * stayed on the old version. It names the version because "an older version" left the
       * reader with no way to tell which, and no way back except guessing.
       */}
      {/*
       * The repair loop writes every failed attempt into `Project.lastCode`, so without the
       * server-side hold-back this pane would compile the broken one and show it. It holds
       * the last version proven to build instead — and says so, because a site that silently
       * lacks the change someone just asked for reads as the request having been ignored.
       * Only ever visible when the server actually substituted a version: the banner is
       * driven by `heldBack` on the files response, never by a local guess about the build.
       */}
      {!previewing && heldBackLabel && (
        <div
          role="status"
          className="flex items-center gap-12 border-b border-amber-500/25 bg-amber-500/10 px-16 py-8"
        >
          <p className="text-[13px] font-medium text-amber-800 dark:text-amber-300">
            {`The newest version does not build, so ${heldBackLabel} — the last one that did — is on screen. Your files are all still in version history.`}
          </p>
        </div>
      )}
      {previewing && (
        <div
          role="status"
          className="flex items-center justify-between gap-12 border-b border-[var(--studio-line)] bg-[var(--studio-surface)] px-16 py-8"
        >
          <p className="text-[13px] font-medium text-[var(--studio-fg)]">
            {previewingLabel
              ? `Viewing ${previewingLabel} — an older version. Your current version is safe.`
              : 'Viewing an older version. Your current version is safe.'}
          </p>
          <button
            type="button"
            onClick={onExitPreview}
            className="inline-flex min-h-[32px] shrink-0 items-center rounded-full border border-[var(--studio-line-strong)] px-12 text-[12px] font-medium text-[var(--studio-fg)] hover:bg-[var(--studio-surface-hover)]"
          >
            Back to current
          </button>
        </div>
      )}
      <div
        ref={shellRef}
        className={cn(
          'relative flex min-h-0 flex-1 justify-center overflow-x-hidden overflow-y-auto',
          frame && 'items-center bg-[var(--studio-skeleton)] py-16',
        )}
      >
        {view === 'preview' ? (
          <span className="pointer-events-none absolute top-12 left-12 z-10 rounded-full bg-[var(--studio-surface)] px-8 py-2 text-[11px] font-medium text-[var(--studio-muted)] shadow-sm">
            {previewKind === 'live' ? LIVE_SANDBOX_LABEL : STATIC_PREVIEW_LABEL}
          </span>
        ) : null}
        {view === 'preview' && scaleLabel ? (
          <span className="pointer-events-none absolute top-12 right-12 z-10 rounded-full bg-[var(--studio-surface)] px-8 py-2 text-[11px] font-medium text-[var(--studio-muted)] shadow-sm">
            {scaleLabel}
          </span>
        ) : null}
        <div
          className="relative"
          style={
            frame
              ? { width: frame.width * scale, height: frame.height * scale, flexShrink: 0 }
              : { width: '100%', height: '100%' }
          }
        >
          <div
            className={cn(
              'relative overflow-hidden',
              frame
                ? 'rounded-16 border border-[var(--studio-line)] bg-[var(--studio-surface)] shadow-sm'
                : 'h-full w-full',
            )}
            style={
              frame
                ? {
                    width: frame.width,
                    height: frame.height,
                    transform: `scale(${scale})`,
                    transformOrigin: 'top left',
                  }
                : undefined
            }
          >
            {view === 'seo' ||
            view === 'assets' ||
            view === 'brain' ||
            view === 'domains' ||
            view === 'code' ||
            !showEmptyPlan ? (
              pane === 'empty' ? (
                <EmptyPreview />
              ) : (
                <>
                  {children}
                  {view === 'preview' && preparingPreview ? (
                    <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center pt-16">
                      <p className="rounded-full bg-[var(--studio-fg)] px-12 py-6 text-[12px] font-medium text-[var(--studio-bg)] shadow-sm">
                        {PREPARING_PREVIEW}
                      </p>
                    </div>
                  ) : null}
                  {view === 'preview' && previewBuildFailed ? (
                    <PreviewBuildFailed log={previewBuildLog} onRetry={onRetryPreview} />
                  ) : null}
                </>
              )
            ) : (
              <div className="flex h-full w-full items-center justify-center px-24 text-center">
                {phase === 'COMPLETE' ? (
                  // The site exists (COMPLETE means lastCode/checkpoint) — the
                  // missing thing is only the preview snapshot. Saying "nothing
                  // built yet" here told users their finished build was lost.
                  <div className="max-w-[320px]">
                    <p className="text-[14px] leading-6 text-[var(--studio-muted)]">
                      The site is built, but no preview snapshot has been captured yet. Send a
                      change in chat to rebuild and capture one.
                    </p>
                  </div>
                ) : (
                  // Planning: nothing to render yet, but "nothing" shouldn't
                  // look dead — a breathing brand orb says the site is coming.
                  <div className="relative flex max-w-[340px] flex-col items-center">
                    <div className="relative mb-24 size-[120px]">
                      <span
                        aria-hidden
                        className="studio-orb absolute inset-0 rounded-full opacity-90 blur-2xl [background-image:var(--studio-cta-gradient)]"
                      />
                      <span
                        aria-hidden
                        className="absolute inset-[18px] rounded-full border border-white/40 bg-[var(--studio-surface)]/60 backdrop-blur-md"
                      />
                      <span
                        aria-hidden
                        className="absolute inset-[34px] rounded-full [background-image:var(--studio-cta-gradient)]"
                      />
                    </div>
                    <p className="text-[17px] font-medium tracking-[-0.02em] text-[var(--studio-fg)]">
                      Something cool is on the way
                    </p>
                    <p className="mt-6 text-[13px] leading-6 text-[var(--studio-muted)]">
                      {planApproved
                        ? 'Your plan is approved. Look for Try again in the chat to pick the build back up.'
                        : 'Your plan is taking shape in the chat. Approve it and this panel becomes your live site.'}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyPreview() {
  return (
    <div className="flex h-full w-full items-center justify-center px-24 text-center">
      <div className="max-w-[320px]">
        <EmptyState
          title="Nothing to preview yet"
          description={PREVIEW_EMPTY}
          className="min-h-0 py-0"
        />
      </div>
    </div>
  );
}

function PreviewBuildFailed({ log, onRetry }: { log?: string | null; onRetry?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="absolute inset-x-16 bottom-16 z-20 rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] p-16 shadow-sm">
      <p className="text-[13px] font-medium text-[var(--studio-fg)]">{PREVIEW_BUILD_FAILED}</p>
      <p className="mt-6 text-[12px] leading-5 text-[var(--studio-muted)]">
        {PREVIEW_NOT_READY_NOTICE}
      </p>
      <div className="mt-10 flex flex-wrap items-center gap-8">
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex min-h-[44px] items-center rounded-full [background-image:var(--studio-cta-gradient)] px-14 text-[12px] font-medium text-white transition-[filter] duration-200 hover:brightness-[1.07] active:brightness-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
        >
          Retry
        </button>
        {/* No "Live mode" fallback here: it was a sandbox VM and that subsystem
            is gone, so Retry (a fresh snapshot build) is the only real action. */}
        {log ? (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="text-[12px] font-medium text-[var(--studio-muted)] hover:text-[var(--studio-fg)]"
          >
            {open ? 'Hide build log' : 'Show build log'}
          </button>
        ) : null}
      </div>
      {open && log ? (
        <pre className="studio-scroll mt-10 max-h-[160px] overflow-auto rounded-8 bg-[var(--studio-bg)] p-10 text-[11px] leading-5 text-[var(--studio-muted)]">
          {log}
        </pre>
      ) : null}
    </div>
  );
}
