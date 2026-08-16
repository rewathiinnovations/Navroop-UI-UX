'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/utils/cn';
import {
  formatElementScopedInstruction,
  type InstructionMode,
} from '@/lib/visual-edits/format-instruction';
import type { SelectedElementPayload, SelectedElementRect } from '@/lib/visual-edits/inspector';

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export default function ElementEditPopover({
  mode,
  payload,
  pageRect,
  sending,
  onCancel,
  onSubmit,
}: {
  mode: InstructionMode;
  payload: SelectedElementPayload;
  pageRect: SelectedElementRect;
  sending?: boolean;
  onCancel: () => void;
  onSubmit: (instruction: string) => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(mode === 'text-edit' ? payload.innerText : '');
  const [offset, setOffset] = useState({ top: pageRect.top + pageRect.height + 8, left: pageRect.left });

  useEffect(() => {
    setDraft(mode === 'text-edit' ? payload.innerText : '');
  }, [mode, payload.innerText, payload.selectorPath]);

  useLayoutEffect(() => {
    const node = popoverRef.current;
    const panel = node?.offsetParent as HTMLElement | null;
    if (!node || !panel) {
      setOffset({ top: pageRect.top + pageRect.height + 8, left: pageRect.left });
      return;
    }
    const panelBox = panel.getBoundingClientRect();
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    const gap = 8;
    let top = pageRect.top + pageRect.height + gap - panelBox.top;
    let left = pageRect.left - panelBox.left;
    if (top + height > panelBox.height - 12) {
      top = pageRect.top - panelBox.top - height - gap;
    }
    left = clamp(left, 12, Math.max(12, panelBox.width - width - 12));
    top = clamp(top, 12, Math.max(12, panelBox.height - height - 12));
    setOffset({ top, left });
  }, [pageRect.height, pageRect.left, pageRect.top, pageRect.width]);

  const canSubmit = Boolean(draft.trim()) && !sending;

  const submit = () => {
    const next = draft.trim();
    if (!next || sending) return;
    onSubmit(
      formatElementScopedInstruction(
        { tagName: payload.tagName, text: payload.innerText, selectorPath: payload.selectorPath },
        next,
        mode,
      ),
    );
  };

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={mode === 'text-edit' ? 'Edit element text' : 'Describe a visual change'}
      className="absolute z-40 w-[min(320px,calc(100%-24px))] rounded-16 border border-[var(--studio-line)] bg-[var(--studio-surface)] p-12 shadow-lg"
      style={{ top: offset.top, left: offset.left }}
    >
      <p className="mb-8 truncate text-[11px] text-[var(--studio-faint)]">
        {payload.tagName}
        {payload.innerText ? ` · ${payload.innerText}` : ''}
      </p>
      {mode === 'text-edit' ? (
        <input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submit();
            }
            if (event.key === 'Escape') onCancel();
          }}
          disabled={sending}
          className="w-full rounded-12 border border-[var(--studio-line-strong)] bg-[var(--studio-bg)] px-12 py-8 text-[13px] text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)] disabled:opacity-60"
        />
      ) : (
        <textarea
          autoFocus
          rows={3}
          value={draft}
          placeholder="Describe the change…"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
            if (event.key === 'Escape') onCancel();
          }}
          disabled={sending}
          className="w-full resize-none rounded-12 border border-[var(--studio-line-strong)] bg-[var(--studio-bg)] px-12 py-8 text-[13px] leading-5 text-[var(--studio-fg)] placeholder:text-[var(--studio-faint)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)] disabled:opacity-60"
        />
      )}
      <div className="mt-10 flex items-center justify-end gap-6">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-10 px-10 py-6 text-[12px] text-[var(--studio-muted)] hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)]"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={submit}
          className={cn(
            'rounded-10 bg-[var(--studio-accent)] px-12 py-6 text-[12px] font-medium text-white hover:bg-[var(--studio-accent-hover)]',
            'disabled:cursor-not-allowed disabled:opacity-40',
          )}
        >
          {sending ? 'Sending…' : 'Submit'}
        </button>
      </div>
    </div>
  );
}
