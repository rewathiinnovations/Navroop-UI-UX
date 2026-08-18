'use client';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowUp, Loader2, Mic, Paperclip } from 'lucide-react';
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
  sandboxLocked = false,
  projectLocked = false,
  recoveryActive = false,
}: {
  projectId: string | null;
  onSend: (text: string, options: SendMessageOptions) => void;
  sending: boolean;
  disabled?: boolean;
  phase?: ProjectPhase | null;
  jobStatus?: string | null;
  sandboxLocked?: boolean;
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

  const building = isChatBuilding({ phase, jobStatus, recoveryActive });
  const planning = phase === 'PLANNING';
  const showMode = !planning && !building;
  const busy = isChatLocked({
    sending,
    disabled,
    phase,
    jobStatus,
    recoveryActive,
    sandboxLocked,
    projectLocked,
  });
  const canSend = Boolean(value.trim()) && !busy;
  const lockHint = sandboxLocked
    ? 'Restarting the project... This can take 30–60 seconds'
    : null;

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
    <form onSubmit={onFormSubmit} className="border-t border-[var(--studio-line)] bg-[var(--studio-surface)] p-12">
      <div className="rounded-16 border border-[var(--studio-line-strong)] bg-[var(--studio-bg)] focus-within:ring-2 focus-within:ring-[var(--studio-ring)]">
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
            <Hint label="Attachments coming soon">
              <button
                type="button"
                disabled
                aria-label="Attach file"
                className="inline-flex size-32 items-center justify-center rounded-10 text-[var(--studio-muted)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Paperclip className="size-15" />
              </button>
            </Hint>
            {/* TODO: wire existing attachments when an upload path exists */}
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
                      'rounded-6 px-8 py-3 text-[11px] font-medium capitalize',
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
            <Hint label="Voice input coming soon">
              <button
                type="button"
                disabled
                aria-label="Voice input coming soon"
                className="inline-flex size-32 items-center justify-center rounded-10 text-[var(--studio-muted)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Mic className="size-15" />
              </button>
            </Hint>
            <button
              type="submit"
              disabled={!canSend}
              aria-label="Send message"
              className="inline-flex size-36 items-center justify-center rounded-full bg-[var(--studio-accent)] text-white hover:bg-[var(--studio-accent-hover)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? <Loader2 className="size-16 animate-spin" /> : <ArrowUp className="size-16" />}
            </button>
          </div>
        </div>
      </div>
    </form>
  );

  if (lockHint) {
    return (
      <Hint label={lockHint} className="block w-full">
        {form}
      </Hint>
    );
  }
  return form;
}
