'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Copy, Link2, MoreHorizontal, RotateCcw, ThumbsDown, ThumbsUp } from 'lucide-react';
import { cn } from '@/utils/cn';
import type { ChatMessage, GenerationFile } from '@/lib/generation/types';
import type { JobResourceIds } from '@/lib/jobs/types';
import { isChatBuilding } from '@/lib/jobs/chat-ui';
import BuildingIndicator from './BuildingIndicator';
import RecoveryPanel from './RecoveryPanel';
import CheckpointCard from './CheckpointCard';
import Hint from './Hint';
import PlanCard from './PlanCard';
import type { Checkpoint, MessageFeedback, ProjectPhase, WorkspacePlan } from './types';
import CreditLimitPanel from './CreditLimitPanel';
import { notify } from '@/lib/notify';

function producedGeneration(message: ChatMessage) {
  return (
    message.type === 'ai' &&
    Boolean(message.metadata?.generatedCode || message.metadata?.appliedFiles?.length)
  );
}

function messageKey(message: ChatMessage, index: number) {
  const stamp =
    message.timestamp instanceof Date ? message.timestamp.toISOString() : String(message.timestamp);
  return `${stamp}-${index}`;
}

async function persistThumbs(projectId: string, rating: 'up' | 'down') {
  try {
    await fetch(`/api/projects/${projectId}/quality-signals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'thumbs', rating }),
    });
  } catch {
    /* signal collection must never break chat */
  }
}

export default function ChatPanel({
  messages,
  projectId,
  isGenerating,
  header,
  onPreviewCheckpoint,
  previewedVersionId = null,
  latestCheckpoint = null,
  children,
  phase,
  plan,
  approving,
  onApprovePlan,
  recovery,
  queueAhead,
  jobStatus,
  streamFiles,
  startedAt,
}: {
  messages: ChatMessage[];
  projectId: string | null;
  isGenerating?: boolean;
  header?: ReactNode;
  onPreviewCheckpoint?: (id: string) => void;
  /** The version the workspace is previewing, so the card can say so (F-156). */
  previewedVersionId?: string | null;
  latestCheckpoint?: Checkpoint | null;
  children?: ReactNode;
  phase?: ProjectPhase | null;
  jobStatus?: string | null;
  plan?: WorkspacePlan | null;
  approving?: boolean;
  onApprovePlan?: () => void;
  recovery?: {
    visible: boolean;
    kind?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    filesWritten: number;
    requestId?: string | null;
    busy?: string | null;
    onKeep?: () => void;
    onRetry?: () => void;
    offerRetry?: boolean;
    nextStep?: string | null;
    onStartOver: () => void;
    resourceIds?: JobResourceIds | null;
  } | null;
  queueAhead?: number | null;
  /**
   * The live generation's files, straight from `GenerationProgressState`. The
   * chat is where the user waits, so it names the file being written rather
   * than sitting on a frozen "Building your project…" for minutes.
   */
  streamFiles?: GenerationFile[] | null;
  /** Job `startedAt`, so the wait shows elapsed time before the first file. */
  startedAt?: string | null;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [feedback, setFeedback] = useState<Record<string, MessageFeedback>>({});
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, isGenerating, phase, plan, approving]);

  const lastGenerationIndex = messages.reduce(
    (found, message, index) => (producedGeneration(message) ? index : found),
    -1,
  );

  /**
   * Where the plan card belongs in the thread.
   *
   * It used to be rendered after the whole message list, so a follow-up question
   * sent an hour later appeared *above* the plan and the approved plan read as the
   * newest thing in the conversation. The card is a chat event like any other: it
   * sits after the last message that predates it.
   */
  const planCard =
    plan && plan.status !== 'SUPERSEDED' ? (
      <PlanCard plan={plan} approving={approving} onApprove={onApprovePlan} />
    ) : null;
  const planDraftedAt = plan ? Date.parse(plan.createdAt) : Number.NaN;
  const planAfterIndex = Number.isNaN(planDraftedAt)
    ? messages.length - 1
    : messages.reduce(
        (found, message, index) => (message.timestamp.getTime() <= planDraftedAt ? index : found),
        -1,
      );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      <div ref={scrollerRef} className="flex-1 overflow-y-auto px-16 py-16">
        {/* A plan older than every message in the thread — a first plan on a
            reopened project — belongs at the top, not appended to the bottom. */}
        {planAfterIndex < 0 ? planCard : null}
        {messages.map((message, index) => {
          const key = messageKey(message, index);
          const showLatest = Boolean(latestCheckpoint) && index === lastGenerationIndex;
          const rating = feedback[key] ?? null;

          return (
            <div key={key} className="mb-16">
              {showLatest && latestCheckpoint && (
                <CheckpointCard
                  checkpoint={latestCheckpoint}
                  isPreviewing={previewedVersionId === latestCheckpoint.id}
                  onPreviewCheckpoint={onPreviewCheckpoint}
                />
              )}
              {message.metadata?.creditDenial ? (
                <CreditLimitPanel denial={message.metadata.creditDenial} />
              ) : (
                <div
                  className={cn('flex', message.type === 'user' ? 'justify-end' : 'justify-start')}
                >
                  <div
                    className={cn(
                      'flex max-w-[92%] flex-col rounded-16 px-14 py-10 text-[13px] leading-5',
                      message.type === 'user' && 'bg-[var(--studio-fg)] text-[var(--studio-bg)]',
                      message.type === 'ai' &&
                        'bg-[var(--studio-surface)] text-[var(--studio-fg)] border border-[var(--studio-line)]',
                      message.type === 'system' &&
                        'bg-[var(--studio-bg)] text-[var(--studio-muted)] border border-[var(--studio-line)]',
                      message.type === 'error' && 'bg-rose-50 text-rose-900 border border-rose-200',
                      message.type === 'command' &&
                        'bg-zinc-900 font-mono text-[12px] text-zinc-100',
                      message.type === 'file-update' &&
                        'bg-[var(--studio-bg)] text-[var(--studio-muted)]',
                    )}
                  >
                    {message.type === 'user' &&
                      (message.metadata?.source === 'visual-edit' ||
                        message.metadata?.source === 'comment') && (
                        <span
                          className={cn(
                            'mb-6 inline-flex rounded-full px-8 py-2 text-[10px] font-medium uppercase tracking-wide',
                            message.type === 'user'
                              ? 'bg-[var(--studio-bg)]/15 text-[var(--studio-bg)]'
                              : 'bg-[var(--studio-accent-soft)] text-[var(--studio-accent)]',
                          )}
                        >
                          {message.metadata.source === 'comment' ? 'Comment' : 'Visual edit'}
                        </span>
                      )}
                    {message.metadata?.skillNames && message.metadata.skillNames.length > 0 && (
                      <div className="mb-6 flex flex-wrap gap-6">
                        {message.metadata.skillNames.map((name) => (
                          <span
                            key={name}
                            className={cn(
                              'inline-flex rounded-full px-8 py-2 text-[10px] font-medium tracking-wide',
                              message.type === 'user'
                                ? 'bg-[var(--studio-bg)]/15 text-[var(--studio-bg)]'
                                : 'bg-[var(--studio-accent-soft)] text-[var(--studio-accent)]',
                            )}
                          >
                            Skill: {name}
                          </span>
                        ))}
                      </div>
                    )}
                    <p className="whitespace-pre-wrap">{message.content}</p>
                  </div>
                </div>
              )}
              {(message.type === 'ai' || message.type === 'user') &&
                !message.metadata?.creditDenial && (
                  <div
                    className={cn(
                      'mt-6 flex items-center gap-2',
                      message.type === 'user' ? 'justify-end' : 'justify-start',
                    )}
                  >
                    <Hint label="Coming soon">
                      <button
                        type="button"
                        disabled
                        aria-label="Revert"
                        className="inline-flex size-28 items-center justify-center rounded-8 text-[var(--studio-faint)] disabled:cursor-not-allowed"
                      >
                        <RotateCcw className="size-13" />
                      </button>
                    </Hint>
                    <button
                      type="button"
                      aria-label="Thumbs up"
                      onClick={() => {
                        const next = rating === 'up' ? null : 'up';
                        setFeedback((prev) => ({ ...prev, [key]: next }));
                        if (next && projectId) void persistThumbs(projectId, next);
                      }}
                      className={cn(
                        'inline-flex size-28 items-center justify-center rounded-8',
                        rating === 'up'
                          ? 'text-[var(--studio-accent)]'
                          : 'text-[var(--studio-faint)] hover:text-[var(--studio-fg)]',
                      )}
                    >
                      <ThumbsUp className="size-13" />
                    </button>
                    <button
                      type="button"
                      aria-label="Thumbs down"
                      onClick={() => {
                        const next = rating === 'down' ? null : 'down';
                        setFeedback((prev) => ({ ...prev, [key]: next }));
                        if (next && projectId) void persistThumbs(projectId, next);
                      }}
                      className={cn(
                        'inline-flex size-28 items-center justify-center rounded-8',
                        rating === 'down'
                          ? 'text-[var(--studio-accent)]'
                          : 'text-[var(--studio-faint)] hover:text-[var(--studio-fg)]',
                      )}
                    >
                      <ThumbsDown className="size-13" />
                    </button>
                    <button
                      type="button"
                      aria-label="Copy text"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(message.content);
                          setCopiedKey(key);
                          window.setTimeout(
                            () => setCopiedKey((current) => (current === key ? null : current)),
                            1200,
                          );
                        } catch {
                          notify.warning('Could not copy — select the text and copy it by hand.', {
                            key: 'chat-copy',
                          });
                        }
                      }}
                      className="inline-flex size-28 items-center justify-center rounded-8 text-[var(--studio-faint)] hover:text-[var(--studio-fg)]"
                    >
                      <Copy className="size-13" />
                    </button>
                    {copiedKey === key && (
                      <span className="text-[11px] text-[var(--studio-faint)]">Copied</span>
                    )}
                    <div className="relative">
                      <button
                        type="button"
                        aria-label="More actions"
                        onClick={() => setMenuFor((current) => (current === key ? null : key))}
                        className="inline-flex size-28 items-center justify-center rounded-8 text-[var(--studio-faint)] hover:text-[var(--studio-fg)]"
                      >
                        <MoreHorizontal className="size-13" />
                      </button>
                      {menuFor === key && (
                        <div className="absolute left-0 top-full z-20 mt-4 min-w-[180px] rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] p-4 shadow-lg">
                          <button
                            type="button"
                            className="flex w-full items-center gap-8 rounded-8 px-10 py-8 text-left text-[12px] text-[var(--studio-fg)] hover:bg-[var(--studio-surface-hover)]"
                            onClick={async () => {
                              const stub = `${window.location.origin}/project/${projectId || 'unknown'}#msg-${index}`;
                              try {
                                await navigator.clipboard.writeText(stub);
                                notify.success('Message link copied.', { key: 'chat-copy' });
                              } catch {
                                notify.warning('Could not copy the link.', { key: 'chat-copy' });
                              }
                              setMenuFor(null);
                            }}
                          >
                            <Link2 className="size-13" />
                            Copy message link
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              {index === planAfterIndex ? planCard : null}
            </div>
          );
        })}
        {latestCheckpoint && lastGenerationIndex < 0 && (
          <CheckpointCard
            checkpoint={latestCheckpoint}
            isPreviewing={previewedVersionId === latestCheckpoint.id}
            onPreviewCheckpoint={onPreviewCheckpoint}
          />
        )}
        {phase === 'PLANNING' && !plan && !recovery?.visible && !isGenerating && (
          // The project row exists but the plan is still streaming in (the
          // dashboard navigates before generation finishes). Shaped like the
          // PlanCard it becomes, so the swap-in doesn't jump the layout.
          <div
            role="status"
            aria-live="polite"
            className="relative mb-16 overflow-hidden rounded-16 border border-[var(--studio-line)] bg-[var(--studio-surface)] p-16"
          >
            <p className="text-[13px] font-medium text-[var(--studio-fg)]">Drafting your plan…</p>
            <p className="mt-4 text-[12px] text-[var(--studio-muted)]">
              Pages, sections, and features are being sketched from your prompt. It lands here in a
              few seconds — review it, then approve to start the build.
            </p>
            <div className="mt-12 space-y-8">
              <span className="block h-10 w-3/4 animate-pulse rounded-8 bg-[var(--studio-skeleton)] motion-reduce:animate-none" />
              <span className="block h-10 w-1/2 animate-pulse rounded-8 bg-[var(--studio-skeleton)] motion-reduce:animate-none" />
              <span className="block h-10 w-2/3 animate-pulse rounded-8 bg-[var(--studio-skeleton)] motion-reduce:animate-none" />
            </div>
            <span aria-hidden className="absolute inset-x-0 bottom-0 h-2 overflow-hidden">
              <span className="studio-sheen block h-full w-1/4 rounded-full bg-gradient-to-r from-transparent via-[var(--studio-accent)] to-transparent" />
            </span>
          </div>
        )}
        {recovery?.visible ? (
          <RecoveryPanel
            kind={recovery.kind}
            errorCode={recovery.errorCode}
            errorMessage={recovery.errorMessage}
            filesWritten={recovery.filesWritten}
            requestId={recovery.requestId}
            busy={recovery.busy}
            onKeep={recovery.onKeep}
            onRetry={recovery.onRetry}
            offerRetry={recovery.offerRetry}
            nextStep={recovery.nextStep}
            onStartOver={recovery.onStartOver}
            resourceIds={recovery.resourceIds}
          />
        ) : (
          isChatBuilding({
            phase,
            jobStatus,
            recoveryActive: recovery?.visible,
            streaming: isGenerating,
          }) && (
            <BuildingIndicator
              trigger={plan?.trigger}
              queueAhead={queueAhead}
              files={streamFiles}
              startedAt={startedAt}
            />
          )
        )}
        {isGenerating &&
          !isChatBuilding({
            phase,
            jobStatus,
            recoveryActive: recovery?.visible,
            streaming: isGenerating,
          }) &&
          !recovery?.visible && (
            <p className="text-[12px] text-[var(--studio-faint)]">Navroop is working…</p>
          )}
        {children}
      </div>
    </div>
  );
}
