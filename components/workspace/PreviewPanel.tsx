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
  const showTools = view === 'preview' && Boolean(sandboxUrl) && !showEmptyPlan;
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
            children
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
