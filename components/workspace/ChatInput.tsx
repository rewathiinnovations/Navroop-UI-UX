'use client';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowUp, Loader2 } from 'lucide-react';
import { cn } from '@/utils/cn';
import { useDraftStorage } from '@/hooks/useDraftStorage';
import { chatPlaceholder, isChatBuilding, isChatLocked } from '@/lib/jobs/chat-ui';
import Hint from './Hint';
import type { ChatMode, ProjectPhase, SendMessageOptions } from './types';

export default function ChatInput({
  projectId,
  onSend,
  sending,
  disabled,
  phase,
  jobStatus,
  projectLocked = false,
  recoveryActive = false,
}: {
  projectId: string | null;
  onSend: (text: string, options: SendMessageOptions) => void;
  sending: boolean;
  disabled?: boolean;
  phase?: ProjectPhase | null;
  jobStatus?: string | null;
  projectLocked?: boolean;
  recoveryActive?: boolean;
}) {
  const draftKey = `navroop_draft_${projectId || 'pending'}`;
  const { value, setValue, clear } = useDraftStorage(draftKey);
  const [mode, setMode] = useState<ChatMode>('build');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value]);

  // `sending` is a stream in this tab; the placeholder must agree with the
  // indicator above it rather than waiting for the first poll.
  const building = isChatBuilding({ phase, jobStatus, recoveryActive, streaming: sending });
  const planning = phase === 'PLANNING';
  const showMode = !planning && !building;
  const busy = isChatLocked({
    sending,
    disabled,
    phase,
    jobStatus,
    recoveryActive,
    projectLocked,
  });
  const canSend = Boolean(value.trim()) && !busy;

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    onSend(trimmed, { mode });
    clear();
  };

  const onFormSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const form = (
    <form
      onSubmit={onFormSubmit}
      className="border-t border-[var(--studio-line)] bg-[var(--studio-surface)] p-14"
    >
      <div className="rounded-16 border border-[var(--studio-line-strong)] bg-[var(--studio-bg)] shadow-[0_1px_0_rgba(24,24,27,0.04)] focus-within:border-[var(--studio-accent)] focus-within:ring-2 focus-within:ring-[var(--studio-ring)]">
        <label htmlFor="navroop-chat-input" className="sr-only">
          Ask Navroop
        </label>
        <textarea
          id="navroop-chat-input"
          ref={textareaRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder={chatPlaceholder({ phase, jobStatus, recoveryActive })}
          disabled={busy}
          className="w-full resize-none bg-transparent px-14 pt-12 pb-4 text-[14px] leading-6 text-[var(--studio-fg)] placeholder:text-[var(--studio-faint)] focus-visible:outline-none disabled:opacity-60"
        />
        <div className="flex items-center justify-between gap-8 px-8 pb-8">
          <div className="flex items-center gap-4">
            {showMode && (
              // Which mode is selected is carried only by background colour, so a screen
              // reader announced two identical unlabelled buttons. `aria-pressed` puts the
              // selection in the accessibility tree, where it is also the only stable hook a
              // test has for "switching mode changed what the send button submits".
              <div
                role="group"
                aria-label="Chat mode"
                className="inline-flex rounded-8 bg-[var(--studio-surface)] p-2"
              >
                {(['plan', 'build'] as const).map((item) => (
                  <button
                    key={item}
                    type="button"
                    aria-pressed={mode === item}
                    onClick={() => setMode(item)}
                    className={cn(
                      'min-h-[44px] rounded-6 px-10 text-[11px] font-medium capitalize',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]',
                      mode === item
                        ? 'bg-[var(--studio-fg)] text-[var(--studio-bg)]'
                        : 'text-[var(--studio-muted)] hover:text-[var(--studio-fg)]',
                    )}
                  >
                    {item}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center gap-4">
            <button
              type="submit"
              disabled={!canSend}
              aria-label="Send message"
              className="studio-icon-hit inline-flex items-center justify-center rounded-full [background-image:var(--studio-cta-gradient)] text-white transition-[filter] duration-200 hover:brightness-[1.07] active:brightness-[0.96] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:brightness-100"
            >
              {busy ? (
                <Loader2 className="size-16 animate-spin" />
              ) : (
                <ArrowUp className="size-16" />
              )}
            </button>
          </div>
        </div>
      </div>
    </form>
  );

  return form;
}
