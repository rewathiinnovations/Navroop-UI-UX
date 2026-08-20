'use client';

import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { ArrowUp, Loader2, Paperclip, X } from 'lucide-react';
import { cn } from '@/utils/cn';
import { useDraftStorage } from '@/hooks/useDraftStorage';
import { chatPlaceholder, isChatBuilding, isChatLocked } from '@/lib/jobs/chat-ui';
import { deleteProjectAsset, uploadProjectAsset } from '@/lib/assets/actions';
import {
  attachmentPromptBlock,
  ATTACHMENT_ACCEPT,
  type PromptAttachment,
} from '@/lib/assets/attachment-prompt';
import { notify, toMessage } from '@/lib/notify';
import Hint from './Hint';
import { restoreAttachmentsIfNotSent, restoreTextIfNotSent } from './types';
import type { ChatMode, ProjectPhase, SendMessageOptions, SendOutcome } from './types';

/**
 * One image attached to the next message (F-091).
 *
 * It is a real `ProjectAsset` the moment it is picked — the composer has no
 * private staging area, so the upload ceiling, the magic-byte sniff, the
 * per-user hourly limiter and the workspace storage charge all already apply.
 * `name` is the filename and is display-only: it never enters the prompt (see
 * `attachmentPromptBlock`).
 */
type ChatAttachment = PromptAttachment & { id: string; name: string };

/** Images only, and only the four types the upload pipeline sniffs for. */
function imageFilesFrom(list: FileList | null | undefined) {
  return Array.from(list ?? []).filter((file) => ATTACHMENT_ACCEPT.includes(file.type));
}

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
  onSend: (text: string, options: SendMessageOptions) => void | Promise<SendOutcome | void>;
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
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
  // An upload in flight blocks the send: the message quotes the attachment URLs,
  // and one that has not come back yet has no URL to quote.
  const canSend = Boolean(value.trim()) && !busy && uploading === 0;

  /**
   * Uploads picked/pasted/dropped images one at a time.
   *
   * Serial on purpose: each one is charged against the workspace's storage limit
   * and the 30-per-hour upload budget, so a refusal must stop the rest of the
   * batch reaching the server rather than race it. Every refusal is named — the
   * upload's own sentence (too large, wrong type, limit reached), not a generic
   * failure.
   */
  const attach = async (files: File[]) => {
    if (files.length === 0) return;
    if (!projectId) {
      notify.error(
        'This project has not been created yet, so there is nowhere to put the image. Send your first message first.',
        { key: 'chat-attach' },
      );
      return;
    }
    setUploading((count) => count + files.length);
    for (const file of files) {
      try {
        const formData = new FormData();
        formData.set('file', file);
        // The upload requires a description and a pasted image has only its
        // filename. That makes it attacker-influenced text, so it is stored as
        // alt text — whose one route into a prompt is the asset manifest, which
        // flattens it (F-105) — and is never quoted in the message itself.
        formData.set('altText', file.name || 'Attached image');
        const result = await uploadProjectAsset(projectId, formData);
        if (!result.ok) {
          notify.error(result.error, { key: 'chat-attach' });
          continue;
        }
        setAttachments((current) => [
          ...current,
          {
            id: result.data.id,
            name: file.name || 'Attached image',
            url: result.data.url,
            width: result.data.width,
            height: result.data.height,
          },
        ]);
      } catch (cause) {
        notify.error(toMessage(cause, 'Could not attach that image'), { key: 'chat-attach' });
      } finally {
        setUploading((count) => count - 1);
      }
    }
  };

  /**
   * Removing a chip deletes the asset. Detaching it instead would leave an image
   * nothing references, still counted against the workspace's storage — the
   * silent cost this product has been removing everywhere else. A delete that
   * fails keeps the chip, because the asset is still there.
   */
  const detach = async (attachment: ChatAttachment) => {
    if (!projectId) return;
    const result = await deleteProjectAsset(projectId, attachment.id).catch((cause) => ({
      ok: false as const,
      error: toMessage(cause, 'Could not remove that image'),
    }));
    if (!result.ok) {
      notify.error(result.error, { key: 'chat-attach' });
      return;
    }
    setAttachments((current) => current.filter((row) => row.id !== attachment.id));
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = imageFilesFrom(event.clipboardData?.files);
    // Nothing pasteable as an image: leave the paste alone so text still lands.
    if (images.length === 0) return;
    event.preventDefault();
    void attach(images);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    const images = imageFilesFrom(event.dataTransfer?.files);
    setDragging(false);
    if (images.length === 0) return;
    event.preventDefault();
    void attach(images);
  };

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed || busy || uploading > 0) return;
    const attached = attachments;
    const sent = onSend(trimmed + attachmentPromptBlock(attached), { mode });
    clear();
    // A send that did not get through — the server refused it because a build was
    // already running, the request was rejected (402/409/503), or the browser was
    // offline — used to disappear from the box, the draft, and the job row at once,
    // leaving the chat bubble as the only copy. Put it back.
    //
    // Through the updater, not the captured `value`: that one is the text just sent,
    // and the outcome lands a round trip later, by which time the box may hold
    // something newer that must not be overwritten.
    void restoreTextIfNotSent(sent, trimmed, setValue);
    // Same rule for the images: they are already uploaded, so a refused send must
    // not silently drop the chips that are the only thing referencing them.
    setAttachments([]);
    void restoreAttachmentsIfNotSent(sent, attached, setAttachments);
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
      {/* Drop target is the whole composer, not the paperclip: a dragged image
          lands wherever the cursor is. `types.includes('Files')` keeps dragged
          text and links from arming the highlight. */}
      <div
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          'rounded-16 border bg-[var(--studio-bg)] shadow-[0_1px_0_rgba(24,24,27,0.04)] focus-within:border-[var(--studio-accent)] focus-within:ring-2 focus-within:ring-[var(--studio-ring)]',
          dragging
            ? 'border-dashed border-[var(--studio-accent)]'
            : 'border-[var(--studio-line-strong)]',
        )}
      >
        <label htmlFor="navroop-chat-input" className="sr-only">
          Ask Navroop
        </label>
        <textarea
          id="navroop-chat-input"
          ref={textareaRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={2}
          placeholder={chatPlaceholder({ phase, jobStatus, recoveryActive })}
          disabled={busy}
          className="w-full resize-none bg-transparent px-14 pt-12 pb-4 text-[14px] leading-6 text-[var(--studio-fg)] placeholder:text-[var(--studio-faint)] focus-visible:outline-none disabled:opacity-60"
        />
        {(attachments.length > 0 || uploading > 0) && (
          <ul className="flex flex-wrap items-center gap-6 px-14 pb-4">
            {attachments.map((attachment) => (
              <li
                key={attachment.id}
                className="inline-flex max-w-[220px] items-center gap-6 rounded-8 border border-[var(--studio-line)] bg-[var(--studio-surface)] py-3 pl-8 pr-4 text-[12px] text-[var(--studio-muted)]"
              >
                <span className="truncate" title={attachment.name}>
                  {attachment.name}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${attachment.name}`}
                  onClick={() => void detach(attachment)}
                  className="inline-flex size-20 items-center justify-center rounded-6 text-[var(--studio-faint)] hover:text-[var(--studio-fg)]"
                >
                  <X className="size-12" />
                </button>
              </li>
            ))}
            {uploading > 0 && (
              <li
                role="status"
                className="inline-flex items-center gap-6 px-4 py-3 text-[12px] text-[var(--studio-muted)]"
              >
                <Loader2 className="size-12 animate-spin" />
                Uploading {uploading} image{uploading === 1 ? '' : 's'}…
              </li>
            )}
          </ul>
        )}
        <div className="flex items-center justify-between gap-8 px-8 pb-8">
          <div className="flex items-center gap-4">
            {/* The image is uploaded to the project and its URL is quoted in the
                request. The model reads that URL and the alt text — it does not see
                the picture: DeepSeek is the only provider and its chat models take
                text only. "Image", not "file", for the same reason the upload sniffs
                magic bytes: a document would be refused. */}
            <Hint
              label={
                projectId
                  ? 'Attach an image — you can also paste or drop one'
                  : 'Send your first message before attaching an image'
              }
            >
              <button
                type="button"
                disabled={busy || !projectId}
                aria-label="Attach an image"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex size-32 items-center justify-center rounded-10 text-[var(--studio-muted)] hover:text-[var(--studio-fg)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Paperclip className="size-15" />
              </button>
            </Hint>
            <input
              ref={fileInputRef}
              type="file"
              accept={ATTACHMENT_ACCEPT}
              multiple
              className="sr-only"
              onChange={(event) => {
                const images = imageFilesFrom(event.target.files);
                event.target.value = '';
                void attach(images);
              }}
            />
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
