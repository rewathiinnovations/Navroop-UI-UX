import {
  CLIENT_POLL_CEILING_MS,
  CLIENT_STALE_HEARTBEAT_MS,
  isHeartbeatStale,
  nextPollIntervalMs,
} from '@/lib/jobs/poll';
import { isJobSettled } from '@/lib/jobs/chat-ui';
import type { GenerationFile, GenerationProgressState } from './types';

/**
 * Reattaching to a build whose stream dropped (F-092).
 *
 * The SSE consumer is one read of one fetch body. There are no event ids and no
 * `Last-Event-ID`, so a dropped connection cannot be resumed at the byte level — and
 * pretending otherwise would need a per-job ring buffer on the server. What the running
 * job already persists is enough for the half that matters: `partialFiles` is every file
 * written so far, `currentStep` is what it is doing, and `heartbeatAt` says whether it is
 * still alive. So after a drop the client polls that row and replays the file set.
 *
 * What resume does *not* recover: the token-by-token `stream` frames and the model's
 * thinking text. Those are gone with the socket, and this module does not invent them —
 * files arrive as completed entries because the server has them, and the status line
 * comes from the job's own step.
 */

export const RESUME_NOTICE = 'Connection dropped — reattaching to the build…';

/** What one poll of the job row tells the resume loop. */
export type ResumeSnapshot = {
  status: string | null;
  currentStep: string | null;
  lastStep: string | null;
  heartbeatAt: string | null;
  files: ReadonlyArray<{ path: string; content: string }>;
  errorCode: string | null;
  errorMessage: string | null;
};

export type ResumeStep =
  | { action: 'replay'; delayMs: number }
  | { action: 'settled'; status: string }
  | { action: 'stop'; reason: 'no-job' | 'stale-heartbeat' | 'timeout' };

/**
 * The same three limits the workspace poller lives by — ceiling, stale heartbeat, and
 * the 2s→10s backoff — so a reattached tab and the recovery panel next to it cannot
 * disagree about whether a build is still being watched.
 */
export function resumeStep(input: {
  snapshot: ResumeSnapshot | null;
  /** Time since the reattachment began. */
  elapsedMs: number;
  now?: Date;
}): ResumeStep {
  if (!input.snapshot) return { action: 'stop', reason: 'no-job' };
  // A settled row is an answer, and it outranks every other consideration: a job that
  // finished one second before its heartbeat aged out has still finished.
  if (isJobSettled(input.snapshot.status)) {
    return { action: 'settled', status: input.snapshot.status ?? 'SUCCEEDED' };
  }
  if (input.elapsedMs >= CLIENT_POLL_CEILING_MS) return { action: 'stop', reason: 'timeout' };
  const now = input.now ?? new Date();
  if (isHeartbeatStale(input.snapshot.heartbeatAt, now, CLIENT_STALE_HEARTBEAT_MS)) {
    return { action: 'stop', reason: 'stale-heartbeat' };
  }
  return { action: 'replay', delayMs: nextPollIntervalMs(input.elapsedMs) };
}

function fileTypeFromPath(filePath: string) {
  const fileExt = filePath.split('.').pop() || '';
  if (fileExt === 'jsx' || fileExt === 'js') return 'javascript';
  if (fileExt === 'css') return 'css';
  if (fileExt === 'json') return 'json';
  if (fileExt === 'html') return 'html';
  return 'text';
}

/**
 * Merges the job's persisted files into the progress state the stream was feeding.
 *
 * Every replayed file is `completed: true` — it is on the row because the server finished
 * writing it — so a block the drop left half-streamed is closed out rather than left as a
 * stub the panel shows forever. Known paths keep their position; new ones are appended in
 * the order the server has them.
 *
 * `streamedCode` and `lastProcessedPosition` are deliberately untouched. They are the
 * fence scanner's buffer and cursor over *this tab's* reply; appending server bytes there
 * would make the scanner re-parse text it never received and count the same file twice.
 */
export function applyResumedFiles(
  prev: GenerationProgressState,
  files: ReadonlyArray<{ path: string; content: string }>,
  step: string,
): GenerationProgressState {
  const next: GenerationFile[] = [...prev.files];
  for (const file of files) {
    const entry: GenerationFile = {
      path: file.path,
      content: file.content,
      type: fileTypeFromPath(file.path),
      completed: true,
      edited: false,
    };
    const existing = next.findIndex((known) => known.path === file.path);
    if (existing >= 0) next[existing] = entry;
    else next.push(entry);
  }
  return {
    ...prev,
    files: next,
    // The build is still running server-side; nothing is streaming into this tab.
    isGenerating: true,
    isStreaming: false,
    isThinking: false,
    thinkingText: undefined,
    currentFile: undefined,
    status: step,
  };
}

/** The status line while reattached: the job's own step, never an invented one. */
export function resumeStatusLine(snapshot: ResumeSnapshot): string {
  return snapshot.currentStep?.trim() || snapshot.lastStep?.trim() || 'Build still running…';
}

/**
 * The heartbeat stopped while we were watching: the worker died mid-build. Distinct from
 * a *settled* job, which `streamDropLine` explains, and from "the poll told us nothing",
 * which is `STREAM_DROPPED_NOTICE`. This module owns only the two lines those do not.
 */
export const RESUME_LOST_LINE =
  'The build stopped responding after the connection dropped, so this tab stopped following it. Use the recovery panel to keep or retry what it wrote.';

export const RESUME_TIMEOUT_LINE =
  'This tab stopped following the build after 25 minutes. Reload the page to see where it got to.';
