'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode, type UIEvent } from 'react';
import {
  ArrowDown,
  ChevronDown,
  ChevronUp,
  Copy,
  Link2,
  MoreHorizontal,
  ThumbsDown,
  ThumbsUp,
} from 'lucide-react';
import { cn } from '@/utils/cn';
import type { ChatMessage, GenerationFile } from '@/lib/generation/types';
import type { JobResourceIds } from '@/lib/jobs/types';
import { isChatBuilding } from '@/lib/jobs/chat-ui';
import BuildingIndicator from './BuildingIndicator';
import RecoveryPanel from './RecoveryPanel';
import CheckpointCard from './CheckpointCard';
import PlanCard from './PlanCard';
import type { Checkpoint, MessageFeedback, ProjectPhase, WorkspacePlan } from './types';
import CreditLimitPanel from './CreditLimitPanel';
import { notify } from '@/lib/notify';

export type ChatScrollMetrics = { scrollTop: number; scrollHeight: number; clientHeight: number };

/** Anything closer than this to the bottom still counts as "at the bottom". */
export const CHAT_BOTTOM_SLACK_PX = 80;

/** Whether the scroller is parked at (or within a line or two of) its end. */
export function isChatAtBottom(metrics: ChatScrollMetrics): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= CHAT_BOTTOM_SLACK_PX;
}

/**
 * Decides the message scroller's next `scrollTop`, and whether the "first
 * paint" pin has happened.
 *
 * `readerScrolledAway` is a fact the caller observes from real scroll events
 * (see `readChatScrollEvent`), not something inferred from geometry. Inferring
 * it is what stranded a reader who had never touched the scroller (F-7): none of the props
 * that grow the thread mid-build — `streamFiles`, `thinkingText`, the recovery
 * panel, the checkpoint card — were in the pinning effect's dependency list, so
 * the effect did not run while the plan card and the streamed reply grew. By the
 * time `messages` changed and it finally ran, the content sat ~1900px past the
 * viewport and the distance rule read that as "they scrolled up", leaving the
 * thread one turn behind for good. Measured live, right after a follow-up edit
 * landed: scrollHeight 3080, clientHeight 346, scrollTop 775.
 *
 * Omitting the argument keeps the old distance rule, for callers with no scroll
 * tracking of their own.
 *
 * Pure so it can be unit-tested directly: this repo's test toolchain has no
 * jsdom/DOM environment, so the decision is exercised here as plain numbers
 * rather than through a rendered scroller element.
 */
export function nextChatScrollTop(
  metrics: ChatScrollMetrics,
  hasPinnedOnce: boolean,
  readerScrolledAway?: boolean,
): { scrollTop: number; hasPinnedOnce: boolean } {
  // First layout with scrollable content pins to the bottom unconditionally,
  // regardless of where the reader's scrollTop happens to sit. Nothing to
  // pin to yet (scrollHeight 0) doesn't count as the first paint.
  if (!hasPinnedOnce && metrics.scrollHeight > 0) {
    return { scrollTop: metrics.scrollHeight, hasPinnedOnce: true };
  }
  const away = readerScrolledAway ?? !isChatAtBottom(metrics);
  if (away) return { scrollTop: metrics.scrollTop, hasPinnedOnce };
  return { scrollTop: metrics.scrollHeight, hasPinnedOnce };
}

/**
 * How far an observed `scrollTop` may sit from the pixel this component last
 * wrote and still be that write coming back as a `scroll` event. Browsers report
 * fractional positions under zoom and on fractional-DPR displays, and clamp an
 * assignment into the reachable range, so the comparison carries slack rather
 * than testing for equality.
 */
export const CHAT_SCROLL_MATCH_PX = 2;

/** How long the "Jump to latest" walk to the end takes. */
export const CHAT_JUMP_DURATION_MS = 280;

/**
 * What the scroller knows about who last moved it.
 *
 * `commandedScrollTop` is the position this component wrote *read back after the
 * browser clamped it*, never the position it asked for. That distinction is the
 * whole point: the pin asks for `scrollHeight`, which is not a `scrollTop` any
 * scroller can hold — the reachable maximum is `scrollHeight - clientHeight` —
 * so the number asked for and the number the viewport actually holds are almost
 * never the same.
 */
export type ChatScrollControl = {
  commandedScrollTop: number | null;
  readerAway: boolean;
};

/**
 * Fold one `scroll` event into the control state.
 *
 * The first attempt at this asked "did a wheel or a touch fire recently?" and
 * held an `autoScroll` flag when neither had. Two separate things were wrong
 * with that. Dragging the scrollbar, Page Up / Page Down, Home / End, the arrow
 * keys, find-in-page and a focus jump all move the viewport without firing
 * either event, so a reader using any of them could never take the scroller
 * back. And the flag's release condition — "did our assignment actually move the
 * viewport?" — compared `scrollTop` against `scrollHeight`, a position no
 * scroller can hold, so a reader already at the bottom made every clamped no-op
 * read as a move: the flag latched, no `scroll` event ever came to clear it, and
 * the next real scroll was swallowed. The pill then never appeared and the next
 * pin yanked them back down — precisely the stranding the pin was written to
 * remove (F-7).
 *
 * Position is what is genuinely knowable. If the viewport sits on the pixel we
 * put it on, the event is ours — or the reader landed on the same pixel, which
 * is the same thing to everyone downstream. Anywhere else it is theirs, by
 * whatever means, including all the ones that fire no event of their own.
 */
export function readChatScrollEvent(
  control: ChatScrollControl,
  metrics: ChatScrollMetrics,
): ChatScrollControl {
  const atBottom = isChatAtBottom(metrics);
  const ours =
    control.commandedScrollTop !== null &&
    Math.abs(metrics.scrollTop - control.commandedScrollTop) <= CHAT_SCROLL_MATCH_PX;
  // A frame of our own walk to the end passes through every position between
  // where it started and there; none of them is the reader parking mid-thread.
  if (ours && !atBottom) return control;
  // Landing at the end settles the question whoever caused it, and any other
  // position is the reader's — which makes the stale command worth nothing.
  return { commandedScrollTop: ours ? control.commandedScrollTop : null, readerAway: !atBottom };
}

export type ChatJumpStep =
  { kind: 'move'; scrollTop: number; last: boolean } | { kind: 'released' };

/**
 * One frame of the "Jump to latest" walk.
 *
 * The walk is driven a frame at a time rather than handed to
 * `scrollTo({ behavior: 'smooth' })` because a native smooth scroll leaves no
 * way to tell that the reader interrupted it: the browser cancels the animation
 * silently and its intermediate positions are not ours to recognise, so a reader
 * who grabs the scrollbar halfway through is indistinguishable from one who did
 * nothing. Writing each frame ourselves makes the previous frame's position a
 * fact to check against, and any input that moves the viewport off it — pointer,
 * keyboard, wheel, touch — hands the scroller back. `commandedScrollTop` going
 * `null` is that same message arriving by the other route: `readChatScrollEvent`
 * clears it the moment it sees a position that is not ours.
 *
 * The end of the thread is re-read every frame, so content streaming in during
 * the walk does not leave it parked short of the newest message.
 */
export function chatJumpStep(args: {
  metrics: ChatScrollMetrics;
  /** Where the walk started, so the curve has a base that does not drift. */
  from: number;
  elapsed: number;
  commandedScrollTop: number | null;
}): ChatJumpStep {
  const { metrics, from, elapsed, commandedScrollTop } = args;
  if (
    commandedScrollTop === null ||
    Math.abs(metrics.scrollTop - commandedScrollTop) > CHAT_SCROLL_MATCH_PX
  ) {
    return { kind: 'released' };
  }
  const end = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
  const progress = Math.min(1, Math.max(0, elapsed / CHAT_JUMP_DURATION_MS));
  const eased = 1 - (1 - progress) ** 3;
  return { kind: 'move', scrollTop: Math.round(from + (end - from) * eased), last: progress >= 1 };
}

/**
 * Whether a change of the project id is a move to a *different* conversation.
 *
 * `null -> id` is not one. That transition happens mid-build, when the row for a
 * run started with no project is created and the id flows down — the reader is
 * still watching the same build, in the same thread, and treating it as a switch
 * would throw their scroll position and their thumbs away under them. The sibling
 * effect in `GenerationWorkspace` that clears the file map and the message list
 * carries exactly this guard for exactly this reason; the two must agree on what
 * "another project" means or one of them resets a conversation the other keeps.
 *
 * Pure and exported so the rule can be exercised as plain values: this repo's test
 * toolchain has no jsdom, so nothing here can be proved by mounting a component
 * and navigating it.
 */
export function isConversationSwitch(previous: string | null, next: string | null): boolean {
  return previous !== null && previous !== next;
}

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
  editingPlan,
  savingPlan,
  onEditPlan,
  onCancelEditPlan,
  onUpdatePlan,
  onStopGeneration,
  recovery,
  queueAhead,
  jobStatus,
  streamFiles,
  startedAt,
  isThinking = false,
  thinkingText,
  thinkingDuration,
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
  editingPlan?: boolean;
  savingPlan?: boolean;
  onEditPlan?: () => void;
  onCancelEditPlan?: () => void;
  onUpdatePlan?: (content: WorkspacePlan['content']) => void;
  onStopGeneration?: () => void;
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
  /** The model is producing chain-of-thought before any file has landed. */
  isThinking?: boolean;
  /** Streaming reasoning text, shown in the collapsible thinking card. */
  thinkingText?: string | null;
  /** How long the model thought, once reasoning has finished. */
  thinkingDuration?: number | null;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const hasPinnedOnceRef = useRef(false);
  /**
   * Who last moved the scroller, and to where. Replaced wholesale rather than
   * mutated in place, so `readChatScrollEvent` stays the only thing that decides.
   */
  const controlRef = useRef<ChatScrollControl>({ commandedScrollTop: null, readerAway: false });
  /** The in-flight "Jump to latest" walk, so the pin can stand out of its way. */
  const jumpFrameRef = useRef<number | null>(null);
  const [showJump, setShowJump] = useState(false);
  const [feedback, setFeedback] = useState<Record<string, MessageFeedback>>({});
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [thinkingOpen, setThinkingOpen] = useState(true);

  const pinToBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    // A jump already walking the viewport to the end re-reads that end on every
    // frame, so snapping past it from here would only make the walk stutter.
    if (jumpFrameRef.current !== null) return;
    // Only pin to the newest message while the reader has not taken the scroller
    // over. Scrolling up to re-read a long plan must not be yanked back down on
    // the next render (a poll, an approving flag, a plan field change) —
    // auto-scroll is a convenience for new content, not a claim on the position.
    const { scrollTop, hasPinnedOnce } = nextChatScrollTop(
      el,
      hasPinnedOnceRef.current,
      controlRef.current.readerAway,
    );
    hasPinnedOnceRef.current = hasPinnedOnce;
    // "Leave them alone" comes back as the very scrollTop that was handed in.
    // Writing it anyway would not be free: assigning `scrollTop` at all kills an
    // in-flight fling on a touchpad or a phone, and a reader who has scrolled
    // away is exactly the person mid-fling.
    if (scrollTop === el.scrollTop) return;
    el.scrollTop = scrollTop;
    // `scrollHeight` is shorthand for "the end", not a position any scroller can
    // hold, so the browser clamps this — for a reader already at the bottom, down
    // to the position they were on, firing no `scroll` event at all. Reading the
    // property back is the only way to learn where the viewport actually landed,
    // and that number is what tells the next scroll event apart from the reader's
    // own. Comparing against the *asked-for* number instead is what latched the
    // old auto-scroll flag for good.
    controlRef.current = { ...controlRef.current, commandedScrollTop: el.scrollTop };
  }, []);

  /**
   * The conversation everything above and below is about, so none of it can
   * outlive that conversation.
   *
   * This component is rendered once, without a `key`, from `ProjectWorkspace`,
   * which `GenerationWorkspace` also renders without one — and switching projects
   * in the sidebar navigates to `/project/{id}`, the same route segment, so React
   * reconciles all three rather than remounting any of them. Every ref and every
   * piece of state in this component therefore crossed the switch intact. The one
   * that stranded readers was `controlRef.readerAway`: someone who had scrolled up
   * in project A arrived in B with the pin already disowned, so B's build streamed
   * past the fold under a "Jump to latest" pill that had been showing since the
   * project opened, and only a real scroll event *in B* could put either right.
   *
   * A `key` on the render site would reset the same state, but it would also reset
   * it on `null -> id` — see `isConversationSwitch` — which is a live build, not a
   * switch. Resetting here instead keeps the guard, and this effect is declared
   * above the pinning effect so it runs first in the same commit: the new thread's
   * first paint has to look like a first paint, or `hasPinnedOnce` would still be
   * true and the new project's opening messages would never be pinned at all.
   */
  const conversationRef = useRef<string | null>(projectId);
  useEffect(() => {
    const previous = conversationRef.current;
    conversationRef.current = projectId;
    if (!isConversationSwitch(previous, projectId)) return;
    hasPinnedOnceRef.current = false;
    controlRef.current = { commandedScrollTop: null, readerAway: false };
    // A walk to the end of A's thread has no business still writing scrollTop into
    // B's, and its next frame would read a `commandedScrollTop` that describes a
    // scroller that no longer holds those messages.
    if (jumpFrameRef.current !== null) {
      cancelAnimationFrame(jumpFrameRef.current);
      jumpFrameRef.current = null;
    }
    setShowJump(false);
    // Ratings are keyed by timestamp and index within *this* thread, so they land
    // on whatever message B happens to have at that key — a thumbs-up the reader
    // gave someone else's answer, shown against a reply they have not read.
    setFeedback({});
    setMenuFor(null);
    setCopiedKey(null);
    setThinkingOpen(true);
  }, [projectId]);

  useEffect(() => {
    pinToBottom();
    // Every prop that puts height in the scroller belongs here. The list used to
    // stop at `editingPlan`, so nothing re-pinned while a build streamed and the
    // thread grew past the viewport under a reader who never moved (F-7).
    //
    // `children` is deliberately not in it. It is a fresh element identity on
    // every parent render, so it re-ran this for renders that changed no height
    // whatsoever — and the height it genuinely can change is already covered, by
    // the ResizeObserver below watching the box that wraps it.
  }, [
    pinToBottom,
    messages,
    isGenerating,
    phase,
    plan,
    approving,
    editingPlan,
    jobStatus,
    queueAhead,
    streamFiles,
    isThinking,
    thinkingText,
    latestCheckpoint,
    recovery?.visible,
  ]);

  useEffect(() => {
    const el = scrollerRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === 'undefined') return;
    // Props are not the only thing that changes scrollHeight: a late web font, an
    // image inside a message, the highlighter chunk landing, or the pane being
    // resized all grow the thread *after* the render effect above has measured
    // it. Observing the content box is what makes the pin hold for those.
    const observer = new ResizeObserver(() => pinToBottom());
    observer.observe(content);
    observer.observe(el);
    return () => observer.disconnect();
  }, [pinToBottom]);

  // Every scroll goes through the same fold, whatever moved the viewport. There
  // is deliberately no `onWheel` / `onTouchStart` companion any more: those two
  // events were the only way the reader could previously reclaim the scroller,
  // and a scrollbar drag or a Page Up fires neither.
  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const next = readChatScrollEvent(controlRef.current, event.currentTarget);
    controlRef.current = next;
    setShowJump(next.readerAway);
  }, []);

  const jumpToLatest = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (jumpFrameRef.current !== null) cancelAnimationFrame(jumpFrameRef.current);
    jumpFrameRef.current = null;
    controlRef.current = { commandedScrollTop: el.scrollTop, readerAway: false };
    setShowJump(false);
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      el.scrollTop = el.scrollHeight;
      controlRef.current = { ...controlRef.current, commandedScrollTop: el.scrollTop };
      return;
    }
    const from = el.scrollTop;
    const startedAt = performance.now();
    const frame = () => {
      const node = scrollerRef.current;
      if (!node) {
        jumpFrameRef.current = null;
        return;
      }
      const step = chatJumpStep({
        metrics: node,
        from,
        elapsed: performance.now() - startedAt,
        commandedScrollTop: controlRef.current.commandedScrollTop,
      });
      if (step.kind === 'released') {
        // The reader took the scroller back mid-walk. The scroll event that says
        // so has already reached `onScroll`; all this has to do is stop pushing.
        jumpFrameRef.current = null;
        return;
      }
      node.scrollTop = step.scrollTop;
      controlRef.current = { ...controlRef.current, commandedScrollTop: node.scrollTop };
      jumpFrameRef.current = step.last ? null : requestAnimationFrame(frame);
    };
    jumpFrameRef.current = requestAnimationFrame(frame);
  }, []);

  useEffect(
    () => () => {
      if (jumpFrameRef.current !== null) cancelAnimationFrame(jumpFrameRef.current);
    },
    [],
  );

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
      <PlanCard
        plan={plan}
        approving={approving}
        editing={editingPlan}
        saving={savingPlan}
        onApprove={onApprovePlan}
        onEdit={onEditPlan}
        onCancelEdit={onCancelEditPlan}
        onUpdate={onUpdatePlan}
      />
    ) : null;
  const planDraftedAt = plan ? Date.parse(plan.createdAt) : Number.NaN;
  const planAfterIndex = Number.isNaN(planDraftedAt)
    ? messages.length - 1
    : messages.reduce(
        (found, message, index) => (message.timestamp.getTime() <= planDraftedAt ? index : found),
        -1,
      );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {header}
      <div ref={scrollerRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-16 py-16">
        {/* The scroller's own box never changes size, so the pin's ResizeObserver
            watches this wrapper: it is the box that grows as the thread does. */}
        <div ref={contentRef}>
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
                    className={cn(
                      'flex',
                      message.type === 'user' ? 'justify-end' : 'justify-start',
                    )}
                  >
                    <div
                      className={cn(
                        'flex max-w-[92%] flex-col rounded-16 px-14 py-10 text-[13px] leading-5',
                        message.type === 'user' && 'bg-[var(--studio-fg)] text-[var(--studio-bg)]',
                        message.type === 'ai' &&
                          'bg-[var(--studio-surface)] text-[var(--studio-fg)] border border-[var(--studio-line)]',
                        message.type === 'system' &&
                          'bg-[var(--studio-bg)] text-[var(--studio-muted)] border border-[var(--studio-line)]',
                        message.type === 'error' &&
                          'bg-[var(--studio-danger)]/10 text-[var(--studio-danger)] border border-[var(--studio-danger)]/25',
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
                      <button
                        type="button"
                        aria-label="Thumbs up"
                        onClick={() => {
                          const next = rating === 'up' ? null : 'up';
                          setFeedback((prev) => ({ ...prev, [key]: next }));
                          if (next && projectId) void persistThumbs(projectId, next);
                        }}
                        className={cn(
                          'studio-icon-hit inline-flex items-center justify-center rounded-8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]',
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
                          'studio-icon-hit inline-flex items-center justify-center rounded-8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]',
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
                            notify.warning(
                              'Could not copy — select the text and copy it by hand.',
                              {
                                key: 'chat-copy',
                              },
                            );
                          }
                        }}
                        className="studio-icon-hit inline-flex items-center justify-center rounded-8 text-[var(--studio-faint)] hover:text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
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
                          className="studio-icon-hit inline-flex items-center justify-center rounded-8 text-[var(--studio-faint)] hover:text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
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
                Pages, sections, and features are being sketched from your prompt. It lands here in
                a few seconds — review it, then approve to start the build.
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
          {isGenerating && !recovery?.visible && (isThinking || thinkingText) ? (
            <div
              role="status"
              aria-live="polite"
              className="mb-16 overflow-hidden rounded-16 border border-purple-500/25 bg-purple-500/5 dark:border-purple-400/20 dark:bg-purple-400/5"
            >
              <button
                type="button"
                onClick={() => setThinkingOpen((open) => !open)}
                aria-expanded={thinkingOpen}
                className="flex w-full items-center gap-8 px-14 py-10 text-left text-[13px] font-medium text-purple-600 dark:text-purple-400"
              >
                {isThinking ? (
                  <>
                    <span
                      aria-hidden
                      className="size-8 shrink-0 rounded-full bg-purple-600 motion-safe:animate-pulse dark:bg-purple-400"
                    />
                    AI is thinking...
                  </>
                ) : (
                  <>
                    <span aria-hidden>✓</span>
                    {typeof thinkingDuration === 'number' && thinkingDuration > 0
                      ? `Thought for ${thinkingDuration} seconds`
                      : 'Finished thinking'}
                  </>
                )}
                <span className="ml-auto shrink-0 text-purple-400">
                  {thinkingOpen ? (
                    <ChevronUp className="size-14" />
                  ) : (
                    <ChevronDown className="size-14" />
                  )}
                </span>
              </button>
              {thinkingOpen && thinkingText ? (
                <div className="max-h-48 overflow-y-auto border-t border-purple-500/20 p-12 scrollbar-hide dark:border-purple-400/15">
                  <pre className="font-mono text-[12px] whitespace-pre-wrap text-purple-700 dark:text-purple-300">
                    {thinkingText}
                  </pre>
                </div>
              ) : null}
            </div>
          ) : null}
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
                onStop={onStopGeneration}
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
            !recovery?.visible &&
            !isThinking &&
            !thinkingText && (
              <p className="text-[12px] text-[var(--studio-faint)]">Navroop is working…</p>
            )}
          {children}
        </div>
      </div>
      {/* The missing half of the pin: when the reader *has* scrolled away, new
          turns land off-screen with nothing to say so. Floating pill, same
          vocabulary as the preview pane's status pills. Rendered always and
          toggled with `display` rather than mounted on demand, so the markup can
          be asserted without a DOM — `hidden` as an attribute would lose to the
          `inline-flex` class in the cascade. */}
      <button
        type="button"
        onClick={jumpToLatest}
        className={cn(
          'absolute bottom-16 left-1/2 z-20 min-h-[44px] -translate-x-1/2 items-center gap-6 rounded-full',
          'border border-[var(--studio-line-strong)] bg-[var(--studio-surface)]/95 px-14 text-[12px]',
          'font-medium text-[var(--studio-fg)] shadow-sm backdrop-blur-sm transition-colors',
          'hover:bg-[var(--studio-surface-hover)]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]',
          showJump ? 'inline-flex' : 'hidden',
        )}
      >
        <ArrowDown className="size-13" aria-hidden />
        Jump to latest
      </button>
    </div>
  );
}
