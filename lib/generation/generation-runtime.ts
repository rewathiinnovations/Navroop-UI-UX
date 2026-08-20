import type { CodeApplicationState } from '@/components/CodeApplicationProgress';
import {
  EMPTY_GENERATION_PROGRESS,
  INITIAL_GENERATION_STATE,
  isActiveGenerationStatus,
  type ApplyResult,
  type ChatMessage,
  type GenerateResult,
  type GenerationFile,
  type GenerationProgressState,
  type GenerationState,
  type GenerationStatus,
  type SandboxData,
  type StartApplyInput,
  type StartGenerationInput,
} from './types';
import { sanitizeGenerationPath } from './parse-files';
import { completedCodeFromFrame } from './complete-frame';
import { emitLockConflict, parseLockConflict } from '@/lib/projects/lock-client';
import { PROJECT_FILES_CHANGED_EVENT } from '@/lib/preview/events';
import { generationRequestErrorMessage } from './request-error';
import { chatTextFromConversation } from './parse-blocks';
import { recoveryCauseLine } from '@/lib/jobs/copy';
import {
  RESUME_LOST_LINE,
  RESUME_NOTICE,
  RESUME_TIMEOUT_LINE,
  applyResumedFiles,
  resumeStatusLine,
  resumeStep,
  type ResumeSnapshot,
} from './stream-resume';

type Listener = () => void;
type JobHandler = (job: RuntimeJob) => Promise<void>;

type RuntimeJob =
  | {
      id: string;
      type: 'generate';
      input: StartGenerationInput;
      resolve: (value: GenerateResult) => void;
      reject: (error: unknown) => void;
    }
  | {
      id: string;
      type: 'apply';
      input: StartApplyInput;
      resolve: (value: ApplyResult) => void;
      reject: (error: unknown) => void;
    };

let state: GenerationState = {
  ...INITIAL_GENERATION_STATE,
  generationProgress: { ...EMPTY_GENERATION_PROGRESS, files: [] },
};
const listeners = new Set<Listener>();
const jobHandlers = new Set<JobHandler>();
const jobQueue: RuntimeJob[] = [];
let jobInFlight = false;

let abortController: AbortController | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let generatePromise: Promise<GenerateResult> | null = null;
let applyPromise: Promise<ApplyResult> | null = null;

function emit() {
  listeners.forEach((listener) => listener());
}

function getAbortController() {
  if (!abortController || abortController.signal.aborted) {
    abortController = new AbortController();
  }
  return abortController;
}

export function getGenerationState(): GenerationState {
  return state;
}

export function subscribeGeneration(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function subscribeGenerationJobs(handler: JobHandler) {
  jobHandlers.add(handler);
  void drainJobs();
  return () => {
    jobHandlers.delete(handler);
  };
}

async function drainJobs() {
  if (jobInFlight || jobHandlers.size === 0) return;
  const job = jobQueue.shift();
  if (!job) return;
  const handler = jobHandlers.values().next().value;
  if (!handler) {
    jobQueue.unshift(job);
    return;
  }
  jobInFlight = true;
  try {
    await handler(job);
  } finally {
    jobInFlight = false;
    if (jobQueue.length > 0) {
      void drainJobs();
    }
  }
}

function enqueueJob(job: RuntimeJob) {
  jobQueue.push(job);
  void drainJobs();
}

export function patchGenerationState(partial: Partial<GenerationState>) {
  state = { ...state, ...partial };
  emit();
}

export function setGenerationProjectId(projectId: string | null) {
  if (state.projectId === projectId) return;
  patchGenerationState({ projectId });
}

export function setGenerationSandboxData(sandboxData: SandboxData | null) {
  patchGenerationState({ sandboxData });
}

export function setGenerationMessages(
  messages: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[]),
) {
  const next = typeof messages === 'function' ? messages(state.messages) : messages;
  patchGenerationState({ messages: next });
}

export function addGenerationMessage(
  content: string,
  type: ChatMessage['type'],
  metadata?: ChatMessage['metadata'],
) {
  setGenerationMessages((prev) => {
    if (type === 'system' && prev.length > 0) {
      const lastMessage = prev[prev.length - 1];
      if (lastMessage.type === 'system' && lastMessage.content === content) {
        return prev;
      }
    }
    return [...prev, { content, type, timestamp: new Date(), metadata }];
  });
}

/**
 * Preview-after-generation copy from persistProjectGeneration. Dedupes across the
 * apply persist path and saveCurrentProject so one generation cannot show the
 * same notice twice. Never throws — a failed notice must not fail the save.
 */
export function surfacePreviewNotice(notice: string | null | undefined) {
  if (typeof notice !== 'string' || !notice.trim()) return;
  if (state.messages.some((message) => message.content === notice)) return;
  addGenerationMessage(notice, 'system');
}

export function setGenerationProgressState(
  progress: GenerationProgressState | ((prev: GenerationProgressState) => GenerationProgressState),
) {
  const next = typeof progress === 'function' ? progress(state.generationProgress) : progress;
  patchGenerationState({
    generationProgress: next,
    streamedText: next.streamedCode,
  });
}

export function setCodeApplicationState(
  next: CodeApplicationState | ((prev: CodeApplicationState) => CodeApplicationState),
) {
  patchGenerationState({
    codeApplicationState: typeof next === 'function' ? next(state.codeApplicationState) : next,
  });
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
 * An opening fence carrying a `{path=…}` tag.
 *
 * `\r?\n` is not decorative: the old opener demanded `}\n`, so a provider that
 * sent CRLF put a `\r` between them and *every* block failed to match — the
 * whole build rendered as prose with no files at all.
 *
 * Kept flagless and cloned per use so no scan inherits another's `lastIndex`,
 * the same discipline `parse-blocks` uses for its own block scan.
 */
const FENCE_OPEN_RE = /```[^\n`]*\{path=([^}\n]+)\}\r?\n/;
/** Where a body ends: the first line-leading fence after it. */
const FENCE_END = '\n```';
/** Sticky: is the fence at this offset the *next* file's opener rather than a close? */
const OPENER_AT_RE = /[^\n`]*\{path=/y;
/**
 * A closing fence that has not fully arrived yet.
 *
 * Held back rather than shown: the last chunks of a file are `\n`, then `` \n` ``,
 * then `` \n`` ``, and only then the fence that ends it. Without this the open
 * body ends in stray backticks that disappear when the third one lands — content
 * that shrinks, which is exactly what the rail promises never happens. A body
 * line that genuinely starts with a backtick is delayed by one chunk, never lost.
 */
const PARTIAL_CLOSE_RE = /\n`{0,2}$/;

/** One `{path=…}` block seen in the accumulated stream text. */
export type StreamedFence = {
  /**
   * Exactly as the model wrote it — never the sanitized spelling. It is the
   * identity that merges a partial entry with its own closed form, so rewriting
   * it would leave two rail entries for one file.
   */
  path: string;
  /** Body, trimmed the way the closed-fence path has always trimmed it. */
  body: string;
  /** False only for a block still being written at the end of the text. */
  closed: boolean;
};

/** What a scan saw, plus where the next one may pick up. */
export type StreamedFenceScan = {
  fences: StreamedFence[];
  /**
   * Resume offset: the position the scan reached after the last *closed* fence.
   * Everything before it is immutable, so the next chunk can be parsed from here
   * instead of from zero.
   */
  cursor: number;
};

/**
 * The blocks visible in accumulated stream text from `from` onwards — closed
 * ones plus, at the end, the one still being written. Pure, so the streaming
 * rail is testable without a stream or a component.
 *
 * A body ends at the first line-leading fence after it, exactly as the previous
 * closed-fence regex ended it, so a finished block's body is byte-for-byte what
 * it was before. Only the end of the text produces `closed: false`.
 *
 * `from` is what stops this being quadratic. It used to run from zero on every
 * chunk, walking every byte of the reply and doing an `indexOf` per fence, so a
 * build's parsing cost grew with the square of its own output (F-040). A closed
 * fence can never change, so resuming past the last one yields exactly the
 * fences a full scan would have yielded after it.
 */
export function scanStreamedFencesFrom(text: string, from: number): StreamedFenceScan {
  const opener = new RegExp(FENCE_OPEN_RE, 'g');
  const probe = new RegExp(OPENER_AT_RE);
  const fences: StreamedFence[] = [];
  let open: StreamedFence | null = null;
  let match: RegExpExecArray | null;
  let cursor = from;
  opener.lastIndex = from;

  while ((match = opener.exec(text)) !== null) {
    const bodyStart = match.index + match[0].length;
    const endIndex = text.indexOf(FENCE_END, bodyStart);
    if (endIndex === -1) {
      // Nothing follows the body yet, so this is the block being written. A later
      // opener replaces the candidate: only the last block can still be open.
      const body = text.slice(bodyStart).replace(PARTIAL_CLOSE_RE, '');
      open = { path: match[1], body: body.trim(), closed: false };
      continue;
    }
    open = null;
    fences.push({ path: match[1], body: text.slice(bodyStart, endIndex).trim(), closed: true });

    // A model that forgets to close a file leaves the *next* file's opener where
    // the closing fence should be. Resuming past those three backticks left
    // `tsx{path=…}` behind, which no longer matched an opener, so every file
    // after the unclosed one vanished — the same fault `parse-blocks` documents
    // for its BLOCK_RE. Resume on the newline instead and re-match the opener.
    probe.lastIndex = endIndex + FENCE_END.length;
    opener.lastIndex = probe.test(text) ? endIndex + 1 : endIndex + FENCE_END.length;
    // The next scan starts exactly where this one resumed, so it re-derives the
    // same fences from here on and never revisits the closed ones.
    cursor = opener.lastIndex;
  }

  if (open) fences.push(open);
  return { fences, cursor };
}

/** Whole-text scan, for a reply that arrived complete rather than in chunks. */
export function scanStreamedFences(text: string): StreamedFence[] {
  return scanStreamedFencesFrom(text, 0).fences;
}

/**
 * Accumulated stream text → the streaming file rail.
 *
 * Contract the panel and the preview rely on:
 * - At most one entry has `completed: false`, and it is the last element.
 * - `completed` only ever goes `false → true`; content only grows.
 * - Once closed, an entry is byte-identical to what the old closed-fence-only
 *   pass produced, so `hasExistingSite`, "Keep what was built" and the
 *   `complete` frame see no change.
 * - A path is gated by the same `sanitizeGenerationPath` the persist path uses,
 *   and a rejected one lands in `droppedPaths` instead of disappearing.
 *
 * Exported for tests: it is a pure function of `prev` and the new text.
 */
export function applyStreamedCode(
  prev: GenerationProgressState,
  text: string,
): GenerationProgressState {
  const newStreamedCode = prev.streamedCode + text;
  // Only closed fences are immutable, so the scan resumes past the last one
  // instead of re-parsing the whole reply on every chunk (F-040). Clamped
  // because `streamedCode` is reset to '' when a run starts, and a cursor left
  // pointing into the previous reply would skip the new one entirely.
  const scanFrom = Math.min(Math.max(prev.lastProcessedPosition, 0), prev.streamedCode.length);
  const scan = scanStreamedFencesFrom(newStreamedCode, scanFrom);
  const updatedState: GenerationProgressState = {
    ...prev,
    streamedCode: newStreamedCode,
    lastProcessedPosition: scan.cursor,
    isStreaming: true,
    isThinking: false,
    status: 'Generating code...',
    files: [...prev.files],
  };

  const completedPaths = new Set(
    prev.files.filter((file) => file.completed).map((file) => file.path),
  );
  let droppedPaths = prev.droppedPaths;
  let openFile: GenerationFile | null = null;
  let closedPath: string | null = null;

  for (const fence of scan.fences) {
    // A finished file cannot change, so skip the work of rebuilding it on every
    // chunk. This also decides `edited` below: the check ran first here before
    // this change too, which made the old `existingFileIndex >= 0` test — the
    // only thing that ever set `edited` — unreachable. Kept false so a closed
    // entry's shape is unchanged; a real edit marker would have to come from the
    // project's stored file map, which this function never sees.
    if (completedPaths.has(fence.path)) continue;

    const safe = sanitizeGenerationPath(fence.path);
    if (!safe.ok) {
      // The persist path drops this same entry server-side. Announcing it is the
      // point: a traversal or absolute path used to leave the rail one file short
      // with nothing anywhere saying why.
      if (!droppedPaths.some((dropped) => dropped.path === fence.path)) {
        droppedPaths = [...droppedPaths, { path: fence.path, reason: safe.code }];
      }
      continue;
    }

    const nextFile: GenerationFile = {
      path: fence.path,
      content: fence.body,
      type: fileTypeFromPath(fence.path),
      completed: fence.closed,
      edited: false,
    };
    // The only entry this can find is the partial emitted for the same block on
    // an earlier chunk, which is last — so replacing keeps the open entry last.
    const existingIndex = updatedState.files.findIndex((file) => file.path === fence.path);
    if (existingIndex >= 0) {
      updatedState.files[existingIndex] = nextFile;
    } else {
      updatedState.files.push(nextFile);
    }

    if (fence.closed) {
      completedPaths.add(fence.path);
      closedPath = fence.path;
    } else {
      openFile = nextFile;
    }
  }

  // One derivation of the status line, from the same fences the rail is built
  // from, so it cannot contradict what the panel renders. "Generating code..."
  // is now only the pre-first-file fallback: the old `if (!prev.isEdit)` guard
  // meant that generic string survived an entire edit stream, while the panel
  // was naming the file it could see being written.
  if (openFile) {
    updatedState.status = `Generating ${openFile.path}`;
  } else if (closedPath) {
    updatedState.status = `Completed ${closedPath}`;
  }

  updatedState.droppedPaths = droppedPaths;
  updatedState.currentFile = openFile
    ? { path: openFile.path, content: openFile.content, type: openFile.type }
    : undefined;

  return updatedState;
}

/** What the streaming panel and the status line read, so neither re-derives it. */
export type StreamingFilesSummary = {
  /** The file being written, or null when no block is open. */
  activePath: string | null;
  filesWritten: number;
  /**
   * Files seen so far, not a forecast: the stream announces no file count up
   * front, so "4 of 9" can only ever mean "4 of the 9 seen so far".
   */
  filesTotal: number;
};

/** O(1) because only the last entry may be incomplete — see `applyStreamedCode`. */
export function summarizeStreamingFiles(files: readonly GenerationFile[]): StreamingFilesSummary {
  const last = files[files.length - 1];
  const activePath = last && !last.completed ? last.path : null;
  return {
    activePath,
    filesWritten: activePath === null ? files.length : files.length - 1,
    filesTotal: files.length,
  };
}

/**
 * Closes out the block that was still streaming when the reply ended. The stream
 * is over, so that content is final; leaving it `completed: false` would show a
 * file as "writing" for good. The server keeps the same block — `parse-blocks`
 * ends a block at end-of-input and flags it `truncated` rather than dropping it
 * — so finalizing here is what keeps the rail and what gets stored in agreement.
 */
export function finalizeStreamedFiles(files: GenerationFile[]): GenerationFile[] {
  const last = files[files.length - 1];
  if (!last || last.completed) return files;
  return [...files.slice(0, -1), { ...last, completed: true }];
}

async function deliverPersistPreviewNotice(response: Response, status?: GenerationStatus) {
  if (status !== 'ready' || !response.ok) return;
  try {
    const data = (await response.json().catch(() => ({}))) as { previewNotice?: unknown };
    surfacePreviewNotice(typeof data.previewNotice === 'string' ? data.previewNotice : null);
  } catch (error) {
    console.error('[generation-runtime] Failed to surface preview notice', error);
  }
}

async function persistProgress(partial: {
  status?: GenerationStatus;
  progressMessage?: string | null;
  previewUrl?: string | null;
}) {
  const projectId = state.projectId;
  if (!projectId) return;
  try {
    const response = await fetch(`/api/projects/${projectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial),
    });
    await deliverPersistPreviewNotice(response, partial.status);
  } catch (error) {
    console.error('[generation-runtime] Failed to persist progress', error);
  }
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!state.projectId || !isActiveGenerationStatus(state.status)) {
      stopHeartbeat();
      return;
    }
    void persistProgress({
      status: state.status,
      progressMessage: state.generationProgress.status || state.status,
    });
  }, 4000);
}

function setJobStatus(status: GenerationStatus, lastError: string | null = null): Promise<void> {
  patchGenerationState({ status, lastError });
  if (isActiveGenerationStatus(status)) {
    startHeartbeat();
    void persistProgress({
      status,
      progressMessage: state.generationProgress.status || status,
    });
    return Promise.resolve();
  }
  stopHeartbeat();
  // No `lastCode` here. The browser used to PATCH the model's raw markdown
  // reply into it, overwriting the normalized `<file path=…>` blocks
  // settleStreamedGeneration had just written server-side. getCurrentProjectFiles
  // finds no file block in markdown and falls back to one bogus `src/App.jsx`
  // holding the whole chat answer, so every finished generation destroyed the
  // multi-file site it had just built. The server owns the site; the client
  // only reports status here.
  return persistProgress({
    status,
    progressMessage: lastError || state.generationProgress.status || status,
    // No sandboxId: the column is gone, and sending it made this PATCH 500 —
    // which is what killed the stream reader on the first progress frame.
    previewUrl: state.sandboxData?.url || null,
  });
}

export function clearGeneration() {
  abortController?.abort();
  abortController = new AbortController();
  stopHeartbeat();
  generatePromise = null;
  applyPromise = null;
  state = {
    ...INITIAL_GENERATION_STATE,
    generationProgress: { ...EMPTY_GENERATION_PROGRESS, files: [] },
    messages: [],
  };
  emit();
}

export function attachToProject(projectId: string | null): GenerationState {
  if (isActiveGenerationStatus(state.status)) {
    return getGenerationState();
  }
  if (projectId && state.projectId !== projectId) {
    // The runtime is a module-level singleton that survives client-side
    // navigation. Carrying the previous project's sandboxData across meant
    // its sandboxId/previewUrl were persisted onto the NEW project's row on
    // the next status write — which then let the server's per-project file
    // cache guard mistake the old sandbox's files for this project's own.
    patchGenerationState({
      projectId,
      sandboxData: null,
      lastGeneratedCode: null,
    });
  }
  return getGenerationState();
}

export function startGeneration(input: StartGenerationInput): Promise<GenerateResult> {
  if (generatePromise && isActiveGenerationStatus(state.status)) {
    const sameProject = !input.projectId || !state.projectId || input.projectId === state.projectId;
    if (sameProject) {
      return generatePromise.then((result) => ({ ...result, alreadyRunning: true }));
    }
  }

  if (input.projectId) {
    patchGenerationState({ projectId: input.projectId });
  }
  if (input.sandboxData) {
    patchGenerationState({ sandboxData: input.sandboxData });
  }

  generatePromise = new Promise<GenerateResult>((resolve, reject) => {
    enqueueJob({
      id: `generate-${Date.now()}`,
      type: 'generate',
      input,
      resolve,
      reject,
    });
  }).finally(() => {
    generatePromise = null;
  });

  return generatePromise;
}

export function startApply(input: StartApplyInput): Promise<ApplyResult> {
  if (applyPromise && state.status === 'applying') {
    return applyPromise.then((result) => ({ ...result, alreadyRunning: true }));
  }

  applyPromise = new Promise<ApplyResult>((resolve, reject) => {
    enqueueJob({
      id: `apply-${Date.now()}`,
      type: 'apply',
      input,
      resolve,
      reject,
    });
  }).finally(() => {
    applyPromise = null;
  });

  return applyPromise;
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}

export async function executeGenerationJob(job: RuntimeJob) {
  if (job.type === 'generate') {
    try {
      job.resolve(await runGenerateStream(job.input));
    } catch (error) {
      if (!isAbortError(error)) {
        markGenerationError(error instanceof Error ? error.message : 'Generation failed');
      }
      job.reject(error);
    }
    return;
  }
  try {
    job.resolve(await runApplyStream(job.input));
  } catch (error) {
    if (!isAbortError(error)) {
      markGenerationError(error instanceof Error ? error.message : 'Failed to apply code');
    }
    job.reject(error);
  }
}

/** The build a job row was last seen in, as the recovery poll reports it. */
type PolledJob = { status: string; errorCode: string | null; errorMessage: string | null };

/**
 * The neutral line for a dropped stream whose job the poll could not read: we do not know
 * whether the build finished, and the detached worker may still be running.
 */
export const STREAM_DROPPED_NOTICE =
  'The connection to the build dropped — checking whether it finished. Reload the project in a moment to see where it got to.';

/**
 * What chat says when the SSE stream ended without a terminal frame.
 *
 * The old code hard-failed every early end with "Failed to generate recreation" — clone
 * vocabulary that means nothing to someone who typed a prompt, and a discard of the
 * reason the job row already carries (F-037). A transport drop is not a generation
 * failure: the build is finishing, finished, or failed for a knowable reason, so say
 * which from the job the poll returned.
 */
export function streamDropLine(job: PolledJob | null): string {
  if (!job) return STREAM_DROPPED_NOTICE;
  if (job.status === 'SUCCEEDED') {
    return 'The connection dropped, but the build finished — reload the project to see it.';
  }
  if (job.status === 'QUEUED' || job.status === 'RUNNING') {
    return 'The connection to the build dropped — it is still running, so reload the project in a moment.';
  }
  // FAILED / ABANDONED / CANCELLED with a cause we have curated copy for.
  return recoveryCauseLine(job.errorCode, job.errorMessage) || STREAM_DROPPED_NOTICE;
}

/** One poll of the job row, with the partial files the reattach loop replays (F-092). */
async function pollForResume(projectId: string): Promise<ResumeSnapshot | null> {
  try {
    const response = await fetch(`/api/projects/${projectId}/job?files=1`);
    if (!response.ok) return null;
    const data = (await response.json()) as {
      job?:
        | (PolledJob & {
            currentStep?: string | null;
            lastStep?: string | null;
            heartbeatAt?: string | null;
          })
        | null;
      partialFiles?: Array<{ path?: unknown; content?: unknown }>;
    };
    if (!data.job) return null;
    const files = (data.partialFiles ?? [])
      .filter(
        (file): file is { path: string; content: string } =>
          typeof file?.path === 'string' && typeof file?.content === 'string',
      )
      .map((file) => ({ path: file.path, content: file.content }));
    return {
      status: data.job.status ?? null,
      currentStep: data.job.currentStep ?? null,
      lastStep: data.job.lastStep ?? null,
      heartbeatAt: data.job.heartbeatAt ?? null,
      files,
      errorCode: data.job.errorCode ?? null,
      errorMessage: data.job.errorMessage ?? null,
    };
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Reattaches to the build after the stream dropped, and keeps reporting until it settles
 * (F-092).
 *
 * This used to be a single poll that printed one line and stopped, so the rest of the
 * build happened with the panel frozen on whatever the last frame had said. There are no
 * event ids to resume the byte stream from, but the job row carries every file written so
 * far, the step it is on and a heartbeat — so the loop replays those until the job settles,
 * its heartbeat goes stale, or the same 25-minute ceiling the workspace poller uses is
 * reached. It never throws and never writes a project status: the verdict is the server's.
 */
async function resumeAfterDrop(): Promise<string> {
  const projectId = state.projectId;
  if (!projectId) return STREAM_DROPPED_NOTICE;
  addGenerationMessage(RESUME_NOTICE, 'system');
  const startedMs = Date.now();

  for (;;) {
    const snapshot = await pollForResume(projectId);
    const decision = resumeStep({ snapshot, elapsedMs: Date.now() - startedMs });

    if (decision.action === 'settled' && snapshot) {
      // Land the last files the build wrote before saying how it ended, so the panel and
      // the closing line agree.
      setGenerationProgressState((prev) => ({
        ...applyResumedFiles(prev, snapshot.files, ''),
        isGenerating: false,
        status: '',
      }));
      return streamDropLine({
        status: decision.status,
        errorCode: snapshot.errorCode,
        errorMessage: snapshot.errorMessage,
      });
    }
    if (decision.action !== 'replay') {
      setGenerationProgressState((prev) => ({ ...prev, isGenerating: false, status: '' }));
      if (decision.action === 'settled') return STREAM_DROPPED_NOTICE;
      if (decision.reason === 'timeout') return RESUME_TIMEOUT_LINE;
      if (decision.reason === 'stale-heartbeat') return RESUME_LOST_LINE;
      return STREAM_DROPPED_NOTICE;
    }

    if (snapshot) {
      setGenerationProgressState((prev) =>
        applyResumedFiles(prev, snapshot.files, resumeStatusLine(snapshot)),
      );
    }
    await sleep(decision.delayMs);
  }
}

async function runGenerateStream(input: StartGenerationInput): Promise<GenerateResult> {
  const controller = getAbortController();
  patchGenerationState({
    startedAt: Date.now(),
    lastError: null,
    status: 'generating',
  });
  setGenerationProgressState((prev) => ({
    ...prev,
    isGenerating: true,
    status: input.isEdit ? 'Starting AI generation...' : 'Initializing AI...',
    components: [],
    currentComponent: 0,
    streamedCode: '',
    isStreaming: !input.isEdit,
    isThinking: Boolean(input.isEdit),
    thinkingText: input.isEdit ? 'Analyzing your request...' : undefined,
    thinkingDuration: undefined,
    currentFile: undefined,
    lastProcessedPosition: 0,
    isEdit: input.isEdit,
    droppedPaths: [],
    // A stream that died mid-file left its `completed: false` entry behind.
    // Carrying that into the next run would show a file as being written by a
    // stream that never opened it. Finished files still carry over.
    files: (prev.files || []).filter((file) => file.completed),
  }));
  setJobStatus('generating');

  const response = await fetch('/api/generate-ai-code-stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: input.prompt,
      model: input.model,
      styleHint: input.styleHint,
      context: input.context,
      isEdit: input.isEdit,
      projectId: input.projectId ?? state.projectId,
      idempotencyKey: input.idempotencyKey ?? undefined,
      // Drives the server's attempt cap and repeated-failure guard. Only a
      // repair generation carries them; an ordinary one must not look like a retry.
      buildFixAttempt: input.buildFixAttempt ?? undefined,
      buildFixSignature: input.buildFixSignature ?? undefined,
    }),
    signal: controller.signal,
  });

  const contentType = response.headers.get('content-type') || '';
  if (response.ok && contentType.includes('application/json')) {
    const body = (await response.json().catch(() => ({}))) as { reused?: boolean };
    if (body.reused) {
      // A build was already in flight, so the route attached to it and answered JSON
      // instead of SSE: nothing is streaming into *this* tab. Settling the runtime is
      // not cosmetic — `setJobStatus('generating')` above armed the 4-second
      // heartbeat, and `isActiveGenerationStatus` is the only thing that stops it, so
      // leaving it set had this tab PATCHing `status: 'generating'` onto the project
      // row for the rest of the session. The job that *is* running is the poller's to
      // report. Handled like the 409 below, which is the same shape of refusal.
      setJobStatus('idle');
      setGenerationProgressState((prev) => ({
        ...prev,
        isGenerating: false,
        isStreaming: false,
        isThinking: false,
      }));
      return {
        generatedCode: '',
        explanation: '',
        packagesToInstall: [],
        skillNames: [],
        alreadyRunning: true,
      };
    }
  }

  if (response.status === 409) {
    const body = await response.json().catch(() => ({}));
    const conflict = parseLockConflict(409, body);
    if (conflict) emitLockConflict(conflict);
    setJobStatus('idle');
    setGenerationProgressState((prev) => ({
      ...prev,
      isGenerating: false,
      isStreaming: false,
      isThinking: false,
    }));
    return { generatedCode: '', explanation: '', packagesToInstall: [], skillNames: [] };
  }

  if (response.status === 402) {
    const body = (await response.json().catch(() => ({}))) as {
      reason?: string;
      used?: number;
      limit?: number;
      message?: string;
    };
    const denial = {
      reason: body.reason || 'workspace_exhausted',
      used: typeof body.used === 'number' ? body.used : 0,
      limit: typeof body.limit === 'number' ? body.limit : 0,
      message: body.message || "This month's credits are used up",
    };
    addGenerationMessage(denial.message, 'error', { creditDenial: denial });
    throw new Error(denial.message);
  }

  if (!response.ok || !response.body) {
    if (response.ok) throw new Error('Failed to generate code');
    // The route answers JSON on every pre-stream refusal — 401, 400, 503
    // PROVIDER_NOT_CONFIGURED, 429 QUEUE_TIMEOUT, 500 GENERATION_FAILED. Throwing
    // `HTTP error! status: N` discarded the sentence the server wrote, including the one
    // that names the page to fix (F-008).
    const body = await response.json().catch(() => null);
    throw new Error(generationRequestErrorMessage(response.status, body));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let generatedCode = '';
  let explanation = '';
  let packagesToInstall: string[] = [];
  let skillNames: string[] = [];
  let buildFix: GenerateResult['buildFix'] = null;
  let buffer = '';
  // A `complete` or `error` frame is the server's verdict on this run. Without one, the
  // read loop ended on a transport failure (a slept laptop, a proxy cutting an idle SSE
  // connection, a redeploy) while the detached worker kept streaming server-side — so
  // the client must not PATCH a status it cannot know (F-036).
  let sawTerminalFrame = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const data = JSON.parse(line.slice(6));
        if (data.type === 'skills' && Array.isArray(data.names)) {
          skillNames = data.names.filter(
            (name: unknown): name is string => typeof name === 'string' && Boolean(name.trim()),
          );
          setGenerationMessages((prev) => {
            const next = [...prev];
            for (let i = next.length - 1; i >= 0; i -= 1) {
              if (next[i].type === 'user') {
                next[i] = {
                  ...next[i],
                  metadata: { ...next[i].metadata, skillNames },
                };
                break;
              }
            }
            return next;
          });
        } else if (data.type === 'status') {
          setGenerationProgressState((prev) => ({ ...prev, status: data.message }));
        } else if (data.type === 'thinking') {
          setGenerationProgressState((prev) => ({
            ...prev,
            isThinking: true,
            thinkingText: (prev.thinkingText || '') + data.text,
          }));
        } else if (data.type === 'thinking_complete') {
          setGenerationProgressState((prev) => ({
            ...prev,
            isThinking: false,
            thinkingDuration: data.duration,
          }));
        } else if (data.type === 'conversation') {
          // Strip the code, keep the prose. The old substring filter dropped the whole
          // frame if it contained `<file`, `import React`, `export default` or
          // `className=`, so an answer that merely named a default export or a Tailwind
          // class was discarded with no chat line — and on the chat-answer path this
          // frame *is* the reply, so the run finished having said nothing (F-050).
          const prose = chatTextFromConversation(data.text || '');
          if (prose) addGenerationMessage(prose, 'ai');
        } else if (data.type === 'stream' && data.raw) {
          setGenerationProgressState((prev) => applyStreamedCode(prev, data.text));
        } else if (data.type === 'app') {
          setGenerationProgressState((prev) => ({
            ...prev,
            status: 'Generated App.jsx structure',
          }));
        } else if (data.type === 'component') {
          setGenerationProgressState((prev) => ({
            ...prev,
            status: `Generated ${data.name}`,
            components: [...prev.components, { name: data.name, path: data.path, completed: true }],
            currentComponent: data.index,
          }));
        } else if (data.type === 'package') {
          setGenerationProgressState((prev) => ({
            ...prev,
            status: data.message || `Installing ${data.name}`,
          }));
        } else if (data.type === 'complete') {
          sawTerminalFrame = true;
          // The frame carries the reply only when the client cannot already hold
          // it — a reused completion, a failover retry, or a reply the route
          // rewrote after streaming it. Otherwise this is exactly the text the
          // `stream` frames accumulated, so it is read back rather than received
          // a second time (F-043).
          generatedCode = completedCodeFromFrame(
            data.generatedCode,
            state.generationProgress.streamedCode,
          );
          explanation = data.explanation || '';
          packagesToInstall = data.packagesToInstall || [];
          if (Array.isArray(data.skillNames) && data.skillNames.length > 0) {
            skillNames = data.skillNames.filter(
              (name: unknown): name is string => typeof name === 'string',
            );
          }
          // The repair instruction the route already paid a validation pass to
          // compute. It used to be parsed and dropped here, which left the whole
          // build-fix loop inert while chat announced a fix that never ran.
          buildFix =
            data.buildFix && typeof data.buildFix.instruction === 'string'
              ? {
                  instruction: data.buildFix.instruction,
                  attempt: Number(data.buildFix.attempt ?? 0),
                  signature:
                    typeof data.buildFix.signature === 'string' ? data.buildFix.signature : null,
                }
              : null;
          if (packagesToInstall.length > 0 && typeof window !== 'undefined') {
            (window as unknown as { pendingPackages?: string[] }).pendingPackages =
              packagesToInstall;
          }
          patchGenerationState({ lastGeneratedCode: generatedCode || null });
          setGenerationProgressState((prev) => {
            // The stream is over, so a block still marked open is just the last
            // file the reply got to. Close it out; the count then describes what
            // the rail actually shows, which the old two-way expression did not.
            //
            // The fallback rail below is for a reply whose blocks never reached
            // the live pass (a reused completion, or a provider that sent no
            // `raw` frames). It re-scans the whole reply, so it is built only
            // when it is actually needed — it used to run on every generation
            // and be thrown away. The same scan the rail uses, so both agree
            // where a block ends, and gated by the same path check, so neither
            // can name a file the persist path refuses.
            const files =
              prev.files.length > 0
                ? finalizeStreamedFiles(prev.files)
                : scanStreamedFences(generatedCode).flatMap((fence) =>
                    sanitizeGenerationPath(fence.path).ok
                      ? [
                          {
                            path: fence.path,
                            content: fence.body,
                            type: fileTypeFromPath(fence.path),
                            completed: true,
                          },
                        ]
                      : [],
                  );
            return {
              ...prev,
              // `complete` with zero files is now a real outcome, not a failure:
              // the route settles a prose-only reply (the "hello" case) as SUCCEEDED
              // and sends the answer here with no files. "Generated 0 files!" reads
              // as a broken build; say what actually happened. A genuine no-files
              // failure still arrives earlier as conversation + an error frame.
              status:
                files.length > 0
                  ? `Generated ${files.length} file${files.length !== 1 ? 's' : ''}!`
                  : 'Answered — no changes made',
              isGenerating: false,
              isStreaming: false,
              isThinking: false,
              thinkingText: undefined,
              thinkingDuration: undefined,
              currentFile: undefined,
              files,
            };
          });
        } else if (data.type === 'error') {
          throw new Error(data.error || 'Generation failed');
        } else if (data.type === 'warning' || data.type === 'info') {
          // Same handling as the apply branch below. The route's degraded-context
          // notices ("could not read your files, working blind") arrive on these
          // two frames; without a case here they were parsed and discarded.
          if (data.message) {
            addGenerationMessage(data.message, 'system');
          }
        }
      } catch (error) {
        if (error instanceof SyntaxError) {
          console.error('Failed to parse SSE data:', error);
          continue;
        }
        throw error;
      }
    }
  }

  if (!generatedCode && !sawTerminalFrame) {
    // The stream ended with no `complete` and no `error` — a transport drop, not a
    // generation failure. The detached worker is still persisting the site and settling
    // the job server-side, so PATCHing `error` here would overwrite a verdict this tab
    // cannot see (F-036). Stop this tab's heartbeat, write no status, then *reattach*:
    // the loop replays the job's persisted files and step until it settles (F-092).
    stopHeartbeat();
    patchGenerationState({ status: 'idle' });
    setGenerationProgressState((prev) => ({
      ...prev,
      isStreaming: false,
      isThinking: false,
    }));
    const line = await resumeAfterDrop();
    addGenerationMessage(line, 'system');
    return {
      generatedCode: '',
      explanation: '',
      packagesToInstall: [],
      skillNames: [],
      streamDropped: true,
    };
  }

  setGenerationProgressState((prev) => ({
    ...prev,
    isGenerating: false,
    isStreaming: false,
    isThinking: false,
    thinkingText: undefined,
    thinkingDuration: undefined,
    status: 'Generation complete!',
  }));

  return { generatedCode, explanation, packagesToInstall, skillNames, buildFix };
}

/**
 * Settles a finished generation.
 *
 * This used to POST the whole reply to /api/apply-ai-code-stream, which wrote
 * the files into a sandbox VM and installed packages. There is no VM: the
 * generate route already parsed the reply and wrote the files to the project,
 * and the preview compiles them in this browser. So the only work left is to
 * mark the generation finished and let the preview pick the new files up.
 */
async function runApplyStream(input: StartApplyInput): Promise<ApplyResult> {
  setJobStatus('applying');
  setCodeApplicationState({ stage: 'applying', filesGenerated: [] });

  // In-memory only: the chat and "save project" read this for the prompt text.
  // It is never PATCHed back as `lastCode` — see setJobStatus.
  patchGenerationState({ lastGeneratedCode: input.code });
  // Terminal status: reports the run finished and surfaces any preview notice.
  await setJobStatus('ready');

  setCodeApplicationState({ stage: 'complete' });
  // Tells the workspace the stored files changed, so the preview rebuilds.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(PROJECT_FILES_CHANGED_EVENT));
  }
  return { finalData: null };
}

export function markGenerationError(message: string) {
  patchGenerationState({ lastError: message });
  setJobStatus('error', message);
  setGenerationProgressState((prev) => ({
    ...prev,
    isGenerating: false,
    isStreaming: false,
    status: '',
  }));
}

export function markGenerationReady() {
  setGenerationProgressState((prev) => ({
    ...prev,
    isGenerating: false,
    isStreaming: false,
    isThinking: false,
    thinkingText: undefined,
    thinkingDuration: undefined,
    status: 'Generation complete!',
    isEdit: false,
  }));
  setJobStatus('ready');
}
