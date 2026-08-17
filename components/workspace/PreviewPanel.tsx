'use client';

import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import { cn } from '@/utils/cn';
import {
  injectInspectorIntoIframe,
  previewOriginFromUrl,
  setInspectorActive,
} from '@/lib/visual-edits/inspector';
import ElementEditPopover from './ElementEditPopover';
import { useElementSelection } from './useElementSelection';
import VisualEditsToolbar from './VisualEditsToolbar';
import type { InstructionMode } from '@/lib/visual-edits/format-instruction';
import type { PlanTrigger, ProjectPhase, SendMessageOptions, ViewportSize, VisualEditTool, WorkspaceView } from './types';
import type { ProjectSandboxState, WorkspaceBootStep } from './useProjectSandbox';

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
  viewport = 'desktop',
  expanded = false,
  view = 'preview',
  onSend,
  sending,
  phase,
  planTrigger,
  previewing = false,
  onExitPreview,
  sandboxState,
  onRetrySandbox,
}: {
  children: ReactNode;
  iframeRef?: RefObject<HTMLIFrameElement | null>;
  sandboxUrl?: string | null;
  selectedPage?: string;
  viewport?: ViewportSize;
  expanded?: boolean;
  view?: WorkspaceView;
  onSend?: (text: string, options: SendMessageOptions) => void;
  sending?: boolean;
  phase?: ProjectPhase | null;
  planTrigger?: PlanTrigger | null;
  previewing?: boolean;
  onExitPreview?: () => void;
  sandboxState?: ProjectSandboxState | null;
  onRetrySandbox?: () => void;
}) {
  const [tool, setTool] = useState<VisualEditTool | null>(null);
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

  const showEmptyPlan = phase === 'PLANNING' && planTrigger !== 'followup';
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
      className={cn(
        'relative flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--studio-bg)]',
        expanded && 'flex-[1.4]',
      )}
    >
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
        className={cn(
          'flex min-h-0 flex-1 justify-center overflow-hidden',
          viewport === 'mobile' && 'bg-[var(--studio-skeleton)] py-16',
        )}
      >
        <div
          className={cn(
            'relative h-full w-full overflow-hidden',
            viewport === 'mobile' &&
              'h-[min(100%,720px)] w-[390px] self-center overflow-hidden rounded-16 border border-[var(--studio-line)] bg-white shadow-sm',
          )}
        >
          {view === 'seo' || view === 'assets' || view === 'brain' || !showEmptyPlan ? (
            sandboxState?.status === 'BOOTING' || sandboxState?.status === 'FAILED' ? (
              <SandboxColdStart
                state={sandboxState}
                onRetry={onRetrySandbox}
              />
            ) : (
              children
            )
          ) : (
            <div className="flex h-full w-full items-center justify-center px-24 text-center">
              <p className="max-w-[280px] text-[14px] leading-6 text-[var(--studio-muted)]">
                Nothing built yet — review the plan and approve to get started
              </p>
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
          {failed ? 'Sandbox start nahi ho paya' : 'Project wapas chalu ho raha hai...'}
        </p>
        <p className="mt-6 text-[13px] leading-6 text-[var(--studio-muted)]">
          {failed
            ? `${stepLabel(state.failedStep)} fail ho gaya.`
            : 'Ismein 30-60 second lag sakte hain'}
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
              className="inline-flex min-h-[36px] items-center rounded-full bg-[var(--studio-accent)] px-16 text-[13px] font-medium text-white hover:bg-[var(--studio-accent-hover)]"
            >
              Dobara koshish karein
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
