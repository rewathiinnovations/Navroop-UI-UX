'use client';

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { cn } from '@/utils/cn';
import {
  formatPreviewScale,
  getPreviewDevice,
  previewScale,
  rotateDeviceSize,
} from '@/lib/preview/devices';
import {
  injectInspectorIntoIframe,
  previewOriginFromUrl,
  setInspectorActive,
} from '@/lib/visual-edits/inspector';
import ElementEditPopover from './ElementEditPopover';
import { useElementSelection } from './useElementSelection';
import VisualEditsToolbar from './VisualEditsToolbar';
import type { InstructionMode } from '@/lib/visual-edits/format-instruction';
import type { PreviewDeviceKey } from '@/lib/preview/devices';
import type { PlanTrigger, ProjectPhase, SendMessageOptions, VisualEditTool, WorkspaceView } from './types';
import type { ProjectSandboxState, WorkspaceBootStep } from './useProjectSandbox';
import { previewPaneKind } from '@/lib/preview/after-generation';
import {
  LIVE_MODE_LABEL,
  LIVE_SANDBOX_LABEL,
  PREPARING_PREVIEW,
  PREVIEW_BUILD_FAILED,
  PREVIEW_EMPTY,
  PREVIEW_NOT_READY_NOTICE,
  STATIC_PREVIEW_LABEL,
} from '@/lib/preview/labels';

const BOOT_STEPS: { id: WorkspaceBootStep; label: string }[] = [
  { id: 'restore', label: 'Files restore' },
  { id: 'install', label: 'Packages install' },
  { id: 'dev', label: 'Server start' },
];

function stepIndex(step: WorkspaceBootStep | null) {
  if (step === 'restore' || step === 'checkpoint' || step === 'probe' || step === 'create') return 0;
  if (step === 'install') return 1;
  if (step === 'dev' || step === 'ready') return 2;
  return 0;
}

function stepLabel(step: WorkspaceBootStep | null) {
  if (step === 'restore' || step === 'checkpoint') return 'Files restore';
  if (step === 'install') return 'Packages install';
  if (step === 'dev' || step === 'ready') return 'Server start';
  if (step === 'create' || step === 'probe') return 'Sandbox create';
  return step || 'Boot';
}

function popoverMode(tool: VisualEditTool | null, hasEditableText: boolean): InstructionMode {
  if (tool === 'instruct' || tool === 'comment') return 'instruction';
  return hasEditableText ? 'text-edit' : 'instruction';
}

/**
 * Thin wrapper around the existing sandbox iframe / code renderer.
 * Does not load iframe content itself — parent owns src and refresh.
 */
export default function PreviewPanel({
  children,
  iframeRef,
  sandboxUrl,
  selectedPage = '/',
  expanded = false,
  previewDevice = 'desktop',
  previewRotated = false,
  view = 'preview',
  onSend,
  sending,
  phase,
  planTrigger,
  previewing = false,
  onExitPreview,
  sandboxState,
  onRetrySandbox,
  previewKind = 'static',
  preparingPreview = false,
  previewBuildFailed = false,
  previewBuildLog = null,
  onRetryPreview,
  onStartLive,
  liveNotice = null,
}: {
  children: ReactNode;
  iframeRef?: RefObject<HTMLIFrameElement | null>;
  sandboxUrl?: string | null;
  selectedPage?: string;
  expanded?: boolean;
  previewDevice?: PreviewDeviceKey;
  previewRotated?: boolean;
  view?: WorkspaceView;
  onSend?: (text: string, options: SendMessageOptions) => void;
  sending?: boolean;
  phase?: ProjectPhase | null;
  planTrigger?: PlanTrigger | null;
  previewing?: boolean;
  onExitPreview?: () => void;
  sandboxState?: ProjectSandboxState | null;
  onRetrySandbox?: () => void;
  previewKind?: 'static' | 'live';
  preparingPreview?: boolean;
  previewBuildFailed?: boolean;
  previewBuildLog?: string | null;
  onRetryPreview?: () => void;
  onStartLive?: () => void;
  liveNotice?: string | null;
}) {
  const [tool, setTool] = useState<VisualEditTool | null>(null);
  const device = previewDevice;
  const rotated = previewRotated;
  const shellRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState({ width: 0, height: 0 });
  const inspectEnabled = view === 'preview' && Boolean(sandboxUrl) && tool !== null;
  const { selection, clearSelection } = useElementSelection({
    iframeRef,
    sandboxUrl,
    enabled: inspectEnabled,
  });

  useEffect(() => {
    if (view === 'preview') return;
    setTool(null);
  }, [view]);

  useEffect(() => {
    const iframe = iframeRef?.current;
    if (!iframe || view !== 'preview') return;

    const sync = () => {
      injectInspectorIntoIframe(iframe);
      setInspectorActive(iframe, inspectEnabled, previewOriginFromUrl(iframe.src) || previewOriginFromUrl(sandboxUrl));
    };

    iframe.addEventListener('load', sync);
    sync();
    return () => {
      iframe.removeEventListener('load', sync);
      setInspectorActive(iframe, false, previewOriginFromUrl(iframe.src) || previewOriginFromUrl(sandboxUrl));
    };
  }, [iframeRef, inspectEnabled, sandboxUrl, selectedPage, view]);

  useEffect(() => {
    const node = shellRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      setAvailable({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const spec = getPreviewDevice(device);
  const frame =
    view === 'preview' && spec.width != null && spec.height != null
      ? rotated
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

  const pane = previewPaneKind({
    phase,
    planTrigger,
    previewUrl: sandboxUrl,
    preparing: preparingPreview,
    previewBuildFailed,
    liveMode: previewKind === 'live',
    sandboxStatus: sandboxState?.status ?? null,
  });
  const showEmptyPlan = pane === 'planning';
  const showTools =
    view === 'preview' &&
    Boolean(sandboxUrl) &&
    !showEmptyPlan &&
    sandboxState?.status !== 'BOOTING' &&
    sandboxState?.status !== 'FAILED';
  const mode = popoverMode(tool, Boolean(selection?.payload.hasEditableText));
  const source = tool === 'comment' ? 'comment' : 'visual-edit';

  return (
    <div
      data-tour="preview"
      className={cn(
        'relative flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--studio-bg)]',
        expanded && 'flex-[1.4]',
      )}
    >
      {liveNotice ? (
        <div className="border-b border-[var(--studio-line)] bg-[var(--studio-surface)] px-16 py-8 text-[12px] text-[var(--studio-muted)]" role="status">
          {liveNotice}
        </div>
      ) : null}
      {previewing && (
        <div className="flex items-center justify-between gap-12 border-b border-[var(--studio-line)] bg-[var(--studio-surface)] px-16 py-8">
          <p className="text-[13px] font-medium text-[var(--studio-fg)]">Viewing an older version</p>
          <button
            type="button"
            onClick={onExitPreview}
            className="inline-flex min-h-[32px] items-center rounded-full border border-[var(--studio-line-strong)] px-12 text-[12px] font-medium text-[var(--studio-fg)] hover:bg-[var(--studio-surface-hover)]"
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
                ? 'rounded-16 border border-[var(--studio-line)] bg-white shadow-sm'
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
          {view === 'seo' || view === 'assets' || view === 'brain' || view === 'domains' || !showEmptyPlan ? (
            pane === 'sandbox-boot' || pane === 'sandbox-failed' ? (
              sandboxState ? (
                <SandboxColdStart
                  state={sandboxState}
                  onRetry={onRetrySandbox}
                />
              ) : (
                <EmptyPreview onStartLive={onStartLive} />
              )
            ) : pane === 'empty' ? (
              <EmptyPreview onStartLive={onStartLive} />
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
                  <PreviewBuildFailed log={previewBuildLog} onRetry={onRetryPreview} onStartLive={onStartLive} />
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
                    The site is built, but no preview snapshot has been captured yet. View it in
                    Live mode, or send a change in chat to rebuild and capture a preview.
                  </p>
                  {onStartLive ? (
                    <button
                      type="button"
                      onClick={onStartLive}
                      className="mt-14 inline-flex min-h-[38px] items-center rounded-full border border-[var(--studio-line-strong)] px-14 text-[13px] font-medium text-[var(--studio-fg)] transition-colors duration-200 hover:bg-[var(--studio-surface-hover)]"
                    >
                      Turn on Live mode
                    </button>
                  ) : null}
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
                    Your plan is taking shape in the chat. Approve it and this panel becomes your
                    live site.
                  </p>
                </div>
              )}
            </div>
          )}
          {showTools && (
            <VisualEditsToolbar
              activeTool={tool}
              onChange={(next) => {
                setTool(next);
                clearSelection();
              }}
            />
          )}
          {inspectEnabled && selection && (
            <ElementEditPopover
              mode={mode}
              payload={selection.payload}
              pageRect={selection.pageRect}
              sending={sending}
              onCancel={clearSelection}
              onSubmit={(instruction) => {
                onSend?.(instruction, { mode: 'build', source });
                clearSelection();
              }}
            />
          )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SandboxColdStart({
  state,
  onRetry,
}: {
  state: ProjectSandboxState;
  onRetry?: () => void;
}) {
  const failed = state.status === 'FAILED';
  const active = stepIndex(state.bootStep);
  return (
    <div className="flex h-full w-full items-center justify-center bg-[var(--studio-bg)] px-24">
      <div className="flex w-full max-w-[360px] flex-col items-center text-center">
        {!failed ? (
          <div className="mb-16 size-36 animate-spin rounded-full border-2 border-[var(--studio-line-strong)] border-t-[var(--studio-accent)]" />
        ) : null}
        <p className="text-[16px] font-medium text-[var(--studio-fg)]">
          {failed ? 'Sandbox failed to start' : 'Restarting the project...'}
        </p>
        <p className="mt-6 text-[13px] leading-6 text-[var(--studio-muted)]">
          {failed
            ? `${stepLabel(state.failedStep)} failed.`
            : 'This can take 30–60 seconds'}
        </p>
        {!failed ? (
          <ol className="mt-20 w-full space-y-8 text-left">
            {BOOT_STEPS.map((item, index) => (
              <li
                key={item.id}
                className={cn(
                  'flex items-center gap-10 text-[13px]',
                  index < active && 'text-[var(--studio-muted)]',
                  index === active && 'font-medium text-[var(--studio-fg)]',
                  index > active && 'text-[var(--studio-faint)]',
                )}
              >
                <span
                  className={cn(
                    'flex size-20 items-center justify-center rounded-full border text-[11px]',
                    index < active && 'border-[var(--studio-accent)] text-[var(--studio-accent)]',
                    index === active && 'border-[var(--studio-accent)] text-[var(--studio-accent)]',
                    index > active && 'border-[var(--studio-line-strong)]',
                  )}
                >
                  {index < active ? '✓' : index + 1}
                </span>
                {item.label}
              </li>
            ))}
          </ol>
        ) : (
          <div className="mt-16 flex flex-col items-center gap-8">
            {state.requestId ? (
              <p className="text-[11px] text-[var(--studio-faint)]">Request {state.requestId.slice(0, 8)}</p>
            ) : null}
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex min-h-[36px] items-center rounded-full [background-image:var(--studio-cta-gradient)] px-16 text-[13px] font-medium text-white transition-[filter] duration-200 hover:brightness-[1.07]"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyPreview({ onStartLive }: { onStartLive?: () => void }) {
  return (
    <div className="flex h-full w-full items-center justify-center px-24 text-center">
      <div className="max-w-[320px]">
        <p className="text-[14px] leading-6 text-[var(--studio-muted)]">{PREVIEW_EMPTY}</p>
        {onStartLive ? (
          <button
            type="button"
            onClick={onStartLive}
            className="mt-16 inline-flex min-h-[36px] items-center rounded-full [background-image:var(--studio-cta-gradient)] px-16 text-[13px] font-medium text-white transition-[filter] duration-200 hover:brightness-[1.07]"
          >
            {LIVE_MODE_LABEL}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function PreviewBuildFailed({
  log,
  onRetry,
  onStartLive,
}: {
  log?: string | null;
  onRetry?: () => void;
  onStartLive?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="absolute inset-x-16 bottom-16 z-20 rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] p-16 shadow-sm">
      <p className="text-[13px] font-medium text-[var(--studio-fg)]">{PREVIEW_BUILD_FAILED}</p>
      <p className="mt-6 text-[12px] leading-5 text-[var(--studio-muted)]">{PREVIEW_NOT_READY_NOTICE}</p>
      <div className="mt-10 flex flex-wrap items-center gap-8">
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex min-h-[32px] items-center rounded-full [background-image:var(--studio-cta-gradient)] px-12 text-[12px] font-medium text-white transition-[filter] duration-200 hover:brightness-[1.07]"
        >
          Retry
        </button>
        {onStartLive ? (
          <button
            type="button"
            onClick={onStartLive}
            className="inline-flex min-h-[32px] items-center rounded-full border border-[var(--studio-line-strong)] px-12 text-[12px] font-medium text-[var(--studio-fg)] hover:bg-[var(--studio-surface-hover)]"
          >
            {LIVE_MODE_LABEL}
          </button>
        ) : null}
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
