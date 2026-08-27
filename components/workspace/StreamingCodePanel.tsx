'use client';

import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type UIEvent,
} from 'react';
import { AlertTriangle, ArrowDownToLine, Check } from 'lucide-react';
import { summarizeStreamingFiles } from '@/lib/generation/generation-runtime';
import type { DroppedGenerationPath, GenerationFile } from '@/lib/generation/types';
import { cn } from '@/utils/cn';
import { streamProgressLabel } from './BuildingIndicator';

/**
 * The generation as it happens: a rail of the files the model has opened and the
 * body of the one being written. It owns no fetching — everything comes from
 * `GenerationProgressState` — so it renders and tests without the workspace.
 */

const JOB_ENUM_STATUS = new Set(['generating', 'applying', 'idle', 'ready', 'error']);

/**
 * The header the empty pane may show. `GenerationState.status` is a job enum
 * (`generating`); putting that in the pane is how a first build sat on
 * "generating" / "Code appears here as each file is written" while the stream
 * was already writing a real progress line.
 */
export function streamPaneStatus(progressStatus: string | null | undefined): string | null {
  const value = progressStatus?.trim() ?? '';
  if (!value) return null;
  if (value === 'generating' || value === 'applying') return 'Writing files…';
  if (JOB_ENUM_STATUS.has(value)) return null;
  return value;
}

/** Anything closer than this to the bottom still counts as "at the bottom". */
const FOLLOW_SLACK_PX = 24;

/**
 * The syntax highlighter, in its own chunk.
 *
 * `lazy` + `import()` keeps the ~1 MB refractor payload out of the workspace
 * route's first client chunk (F-639); the chunk is fetched only when a file is
 * first shown. Declared at module scope, so it is a stable component type rather
 * than one created during render. The Suspense fallback renders the raw code, so
 * the body is never blank while the chunk loads — and on the server, where the
 * lazy import cannot resolve, the same fallback is what renders.
 */
const StreamedCodeBlock = lazy(() => import('./StreamedCodeBlock'));

export type StreamingPanelSelection = {
  /** The body tracks whichever file the stream is writing. */
  following: boolean;
  /** The file the reader chose; only consulted while not following. */
  pinnedPath: string | null;
};

export type StreamingPanelEvent =
  { type: 'pick'; path: string } | { type: 'follow' } | { type: 'scrolled-away' };

/**
 * Being yanked to another file mid-read is the failure mode this whole panel is
 * designed around, so following is given up on the first sign the reader is
 * driving and only ever comes back through the explicit control.
 */
export function selectionReducer(
  state: StreamingPanelSelection,
  event: StreamingPanelEvent,
): StreamingPanelSelection {
  switch (event.type) {
    case 'pick':
      return { following: false, pinnedPath: event.path };
    case 'follow':
      return { following: true, pinnedPath: null };
    case 'scrolled-away':
      // No pin: the reader scrolled inside the streaming file, so keep showing
      // it, just stop dragging the viewport to the bottom.
      return state.following ? { following: false, pinnedPath: state.pinnedPath } : state;
  }
}

/**
 * The file a finished build should open on, per stack, most specific first.
 *
 * A settled build has no open file, so the body fell through to the last entry
 * in the rail — `components/Footer.tsx` on the measured build, the last thing
 * streamed and the least informative thing to land on. `GenerationProgressState`
 * carries no stack field, so the stack is read off the file set itself: Next's
 * app router, then its pages router, then React/Vite, then static HTML. Match is
 * case-insensitive because `App.tsx` and `app.tsx` both occur in the wild.
 */
const ENTRY_CANDIDATES = [
  'app/page.tsx',
  'app/page.jsx',
  'src/app/page.tsx',
  'src/app/page.jsx',
  'pages/index.tsx',
  'pages/index.jsx',
  'src/pages/index.tsx',
  'src/pages/index.jsx',
  'src/app.tsx',
  'src/app.jsx',
  'src/main.tsx',
  'src/main.jsx',
  'src/index.tsx',
  'src/index.jsx',
  'app.tsx',
  'app.jsx',
  'index.html',
  'public/index.html',
  'src/index.html',
];

/** The entry file among `files`, or the first one written when none is known. */
export function entryFile(files: GenerationFile[]): GenerationFile | null {
  for (const candidate of ENTRY_CANDIDATES) {
    const match = files.find((file) => file.path.toLowerCase() === candidate);
    if (match) return match;
  }
  // An unfamiliar layout, or a stack this list has not been taught. The first
  // file written still beats the last: generators emit the shell before the leaf
  // components it imports.
  return files[0] ?? null;
}

/** Which file the body shows: the reader's pick wins, otherwise the open one. */
export function visibleFile(
  files: GenerationFile[],
  selection: StreamingPanelSelection,
  activePath: string | null,
  settled = false,
): GenerationFile | null {
  if (!selection.following && selection.pinnedPath) {
    const pinned = files.find((file) => file.path === selection.pinnedPath);
    if (pinned) return pinned;
  }
  if (activePath) {
    const open = files.find((file) => file.path === activePath);
    if (open) return open;
  }
  // `settled` means the build is over, not merely that the parser sits between
  // two fences: mid-stream `activePath` is null after a closed `</file>` and
  // before the next opener, and jumping to the entry file there would pull the
  // reader off the file they are watching every time one finishes.
  if (settled) {
    const entry = entryFile(files);
    if (entry) return entry;
  }
  return files.length > 0 ? (files[files.length - 1] ?? null) : null;
}

/** Matches the language choice the workspace Code view makes. */
export function codeLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  if (ext === 'css') return 'css';
  if (ext === 'json') return 'json';
  if (ext === 'html') return 'html';
  return 'jsx';
}

/**
 * `sanitizeGenerationPath` returns `empty` both for a blank path and for any
 * path with an empty segment, and the segment check runs first — so `/etc/x`
 * arrives here as `empty`, not `absolute_path`. "Empty path" would therefore be
 * a confidently wrong label on the most common case.
 */
const DROP_REASONS: Record<string, string> = {
  absolute_path: 'absolute path',
  path_traversal: 'path escapes the project',
  invalid_path: 'quote in path',
  duplicate_path: 'duplicate path',
  empty: 'blank or malformed path',
  too_large: 'file too large',
  binary: 'binary content',
  invalid_json: 'invalid JSON',
  unterminated: 'never closed',
};

function StreamingCodePanel({
  files,
  activePath,
  droppedPaths = [],
  status,
  streamedText,
  settled = false,
  className,
}: {
  files: GenerationFile[];
  /**
   * Overrides which file counts as open. Normally omitted: the trailing
   * incomplete entry is the answer, and the selector is the only thing allowed
   * to work that out.
   */
  activePath?: string | null;
  droppedPaths?: DroppedGenerationPath[];
  /** `GenerationProgressState.status` — the model's own phase text. */
  status?: string | null;
  /**
   * The raw reply so far (`GenerationProgressState.streamedCode`), rendered ONLY
   * before the first `{path=…}` opener arrives.
   *
   * No file can appear until the model names one, and on a large brief that took
   * minutes — the pane sat on "Waiting for the first file…" and read as hung
   * while the job was streaming the whole time and its heartbeat was healthy.
   * Showing the reply as it lands is the difference between a spinner and
   * watching it work.
   */
  streamedText?: string | null;
  /**
   * The build has finished. Only then does the panel pick an entry file for the
   * reader instead of whatever the stream left at the end of the rail.
   */
  settled?: boolean;
  className?: string;
}) {
  const [selection, dispatch] = useReducer(selectionReducer, {
    following: true,
    pinnedPath: null,
  });
  const bodyRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(false);

  const progress = useMemo(() => summarizeStreamingFiles(files), [files]);
  const openPath = activePath === undefined ? progress.activePath : activePath;
  const shown = visibleFile(files, selection, openPath, settled);
  const progressLabel = streamProgressLabel(progress);

  useEffect(() => {
    if (!selection.following) return;
    const node = bodyRef.current;
    if (!node) return;
    const bottom = node.scrollHeight - node.clientHeight;
    // Only claim the next scroll event when this actually moves the viewport;
    // otherwise the flag survives and swallows the reader's first real scroll.
    if (Math.abs(node.scrollTop - bottom) < 1) return;
    autoScrollRef.current = true;
    node.scrollTop = bottom;
  }, [selection.following, shown?.path, shown?.content]);

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    if (autoScrollRef.current) {
      autoScrollRef.current = false;
      return;
    }
    const node = event.currentTarget;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    if (distance > FOLLOW_SLACK_PX) dispatch({ type: 'scrolled-away' });
  }, []);

  return (
    <div
      className={cn(
        'flex h-full min-h-0 w-full flex-col overflow-hidden rounded-12 border border-[var(--studio-line)] bg-[#1e1e1e] md:flex-row',
        className,
      )}
    >
      {/*
        Below `md` the rail stops being a column and becomes a scrolling strip of
        file chips above the code. At a 747px viewport the fixed 240px rail left
        the code element 94px of measure against a 1638px scrollWidth — 6% of
        each line, the rest behind a horizontal scrollbar (F-8). `md` is the
        breakpoint the workspace already changes shape at (below it the app
        sidebar is a drawer), not a new one invented here; the wide layout is
        untouched.
      */}
      <nav
        aria-label="Files being written"
        className="flex shrink-0 gap-2 overflow-auto border-b border-white/10 p-8 md:w-[240px] md:flex-col md:border-b-0 md:border-r"
      >
        {files.length === 0 ? (
          <p className="px-8 py-6 text-[12px] text-white/45">No files yet.</p>
        ) : null}
        {files.map((file) => (
          <button
            key={file.path}
            type="button"
            data-state={file.completed ? 'done' : 'writing'}
            aria-current={shown?.path === file.path}
            onClick={() => dispatch({ type: 'pick', path: file.path })}
            className={cn(
              'flex shrink-0 items-center gap-8 rounded-8 px-8 py-6 text-left text-[12px] transition-colors',
              'max-w-[200px] md:max-w-none',
              shown?.path === file.path
                ? 'bg-white/12 text-white'
                : 'text-white/65 hover:bg-white/8 hover:text-white',
            )}
          >
            {file.completed ? (
              <Check aria-label="written" className="size-13 shrink-0 text-emerald-400" />
            ) : (
              <span
                aria-label="writing"
                role="img"
                className="size-8 shrink-0 rounded-full bg-amber-400 motion-safe:animate-pulse"
              />
            )}
            <span className="min-w-0 flex-1 truncate" title={file.path}>
              {file.path}
            </span>
          </button>
        ))}

        {droppedPaths.length > 0 ? (
          // The audit found several silent drops here. A path the parser refused
          // is a file the user asked for and will not get, so it is reported.
          <div className="ml-8 max-w-[280px] shrink-0 rounded-8 border border-amber-500/40 bg-amber-500/10 p-8 md:ml-0 md:mt-8 md:max-w-none">
            <p className="flex items-center gap-6 text-[12px] font-medium text-amber-200">
              <AlertTriangle className="size-13 shrink-0" />
              {droppedPaths.length === 1
                ? '1 file skipped'
                : `${droppedPaths.length} files skipped`}
            </p>
            <ul className="mt-6 flex flex-col gap-4">
              {droppedPaths.map((dropped) => (
                <li key={dropped.path} className="text-[11px] leading-4 text-amber-100/80">
                  <span className="break-all font-mono">{dropped.path || '(empty path)'}</span>
                  <span className="text-amber-100/60">
                    {' '}
                    — {DROP_REASONS[dropped.reason] ?? dropped.reason}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-12 border-b border-white/10 px-12 py-8">
          <span className="min-w-0 flex-1 truncate text-[12px] text-white/70">
            {shown ? shown.path : (status ?? 'Waiting for the first file…')}
          </span>
          {progressLabel ? (
            <span className="hidden shrink-0 text-[11px] text-white/45 sm:block">
              {progressLabel}
            </span>
          ) : null}
          {!selection.following ? (
            <button
              type="button"
              onClick={() => dispatch({ type: 'follow' })}
              className="inline-flex shrink-0 items-center gap-6 rounded-full border border-white/20 px-10 py-4 text-[11px] font-medium text-white/80 transition-colors hover:bg-white/10"
            >
              <ArrowDownToLine className="size-12" />
              Follow along
            </button>
          ) : null}
        </header>

        <div ref={bodyRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-auto">
          {shown ? (
            <Suspense
              fallback={
                // The code with no colours until the highlighter chunk lands —
                // and on the server, where the lazy import cannot resolve. Never
                // a blank pane.
                <pre className="m-0 whitespace-pre-wrap break-words p-16 font-mono text-[14px] leading-5 text-white/80">
                  {shown.content}
                </pre>
              }
            >
              <StreamedCodeBlock language={codeLanguage(shown.path)} code={shown.content} />
            </Suspense>
          ) : streamedText ? (
            // Tail, not the whole reply: this re-renders on every chunk, and the
            // reader only ever sees the bottom anyway.
            <pre className="whitespace-pre-wrap break-words p-16 font-mono text-[12px] leading-5 text-white/70">
              {streamedText.slice(-4000)}
            </pre>
          ) : (
            <p className="p-16 text-[12px] text-white/45">
              Code appears here as each file is written.
            </p>
          )}
          {/* Blinking cursor at the end of the file being written */}
          {shown && !shown.completed ? (
            <span
              aria-hidden="true"
              className="inline-block h-[1.1em] w-[2px] translate-y-[1px] animate-pulse bg-emerald-400 ml-16"
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Memoised because the workspace root re-renders on every state change it owns —
 * ~40 `useState` hooks, several of which tick during a build — and this panel
 * re-renders a syntax-highlighted file body each time (F-641). Its props change
 * only when the stream does, so every other render is skipped.
 *
 * Callers must keep `files` referentially stable when nothing streamed; passing
 * a fresh `[]` per render defeats this.
 */
export default memo(StreamingCodePanel);
