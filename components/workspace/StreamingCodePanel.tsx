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

/** Which file the body shows: the reader's pick wins, otherwise the open one. */
export function visibleFile(
  files: GenerationFile[],
  selection: StreamingPanelSelection,
  activePath: string | null,
): GenerationFile | null {
  if (!selection.following && selection.pinnedPath) {
    const pinned = files.find((file) => file.path === selection.pinnedPath);
    if (pinned) return pinned;
  }
  if (activePath) {
    const open = files.find((file) => file.path === activePath);
    if (open) return open;
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
  const shown = visibleFile(files, selection, openPath);
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
        'flex h-full min-h-0 w-full overflow-hidden rounded-12 border border-[var(--studio-line)] bg-[#1e1e1e]',
        className,
      )}
    >
      <nav
        aria-label="Files being written"
        className="flex w-[240px] shrink-0 flex-col gap-2 overflow-y-auto border-r border-white/10 p-8"
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
              'flex items-center gap-8 rounded-8 px-8 py-6 text-left text-[12px] transition-colors',
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
          <div className="mt-8 rounded-8 border border-amber-500/40 bg-amber-500/10 p-8">
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

      <div className="flex min-w-0 flex-1 flex-col">
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
