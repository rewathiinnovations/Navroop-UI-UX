'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { assemblePreview, type PreviewAssembly } from '@/lib/preview/assemble';
import { bundlePreview } from '@/lib/preview/bundle';
import { buildPreviewSrcdoc, PREVIEW_MESSAGE_SOURCE } from '@/lib/preview/html';
import { summarizeStreamingFiles } from '@/lib/generation/generation-runtime';
import type { GenerationFile } from '@/lib/generation/types';
import { cn } from '@/lib/utils';

/**
 * Renders a generated project entirely in the browser: esbuild-wasm bundles the
 * files, esm.sh serves the runtime dependencies, and the result runs in a
 * sandboxed iframe. No sandbox VM, no dev server, no network round trip.
 *
 * It is also mounted *during* a generation, so every state below has to survive
 * an incomplete project: two of nine files written is normal, not broken.
 */

export type PreviewState =
  | { status: 'idle' }
  /** Not enough code to bundle yet, and a stream is still writing. Not an error. */
  | { status: 'waiting'; reason: string }
  | { status: 'bundling'; srcdoc?: string }
  | { status: 'running'; srcdoc: string }
  | { status: 'ready'; srcdoc: string }
  | { status: 'error'; message: string; srcdoc?: string };

/** The live generation, when the pane is mounted mid-build. */
export type PreviewStream = {
  /** `GenerationProgressState.files`; at most the last entry is incomplete. */
  files: GenerationFile[];
  /** False once the stream has ended, which flushes the settle window. */
  active: boolean;
};

/** A module that never loads fires no error anywhere; without this the frame hangs blank. */
const READY_WATCHDOG_MS = 15_000;

/**
 * How long a burst of file completions has to go quiet before we rebuild.
 * esbuild-wasm runs on this thread, so compiling per completed file competes
 * with the streaming UI for the same frames.
 */
const DEFAULT_SETTLE_MS = 400;

/** What the bundler is pointed at, and the identity that decides "same code". */
export type SettleTarget = { key: string; assembly: PreviewAssembly };

export type SettleState = {
  /** Compiled, or compiling right now. */
  active: SettleTarget;
  /** Newer code waiting out the settle window. */
  pending: SettleTarget | null;
};

export type SettleEvent =
  { type: 'files'; target: SettleTarget; settling: boolean } | { type: 'settled' };

/**
 * Rebuild scheduling as data, so the coalescing rule is testable without a DOM:
 * while a stream is running a new file set only becomes `active` after the
 * window elapses, so two completions 100ms apart produce one compile of the
 * later set — the earlier one is never promoted.
 */
export function settleReducer(state: SettleState, event: SettleEvent): SettleState {
  if (event.type === 'settled') {
    return state.pending ? { active: state.pending, pending: null } : state;
  }
  if (event.target.key === state.active.key) {
    // The files came back to what is already on screen; drop the queued rebuild.
    return state.pending ? { active: state.active, pending: null } : state;
  }
  if (!event.settling) return { active: event.target, pending: null };
  if (state.pending?.key === event.target.key) return state;
  return { active: state.active, pending: event.target };
}

function srcdocOf(state: PreviewState): string | undefined {
  return 'srcdoc' in state ? state.srcdoc : undefined;
}

/**
 * A failure never blanks a preview that already rendered. Before this, a bundle
 * error dropped the srcdoc, so one bad intermediate state during a stream wiped
 * a working pane and only a full rebuild brought it back.
 */
export function previewError(prev: PreviewState, message: string): PreviewState {
  return { status: 'error', message, srcdoc: srcdocOf(prev) };
}

/**
 * There is nothing to bundle. Mid-stream that means the root component has not
 * been written yet, which is a normal second of a build; with no stream running
 * it is a real dead end and reads as an error.
 */
export function emptyAssemblyState(
  prev: PreviewState,
  reason: string,
  streaming: boolean,
): PreviewState {
  if (!streaming) return previewError(prev, reason);
  // Something already renders — a transient gap must not take it off screen.
  if (srcdocOf(prev)) return prev;
  return { status: 'waiting', reason };
}

/** Honest progress copy: the stream announces no total, so nothing claims one. */
export function waitingMessage(
  summary: { activePath: string | null; filesWritten: number } | null,
): string {
  if (!summary || summary.filesWritten === 0) {
    return summary?.activePath
      ? `Writing ${summary.activePath} — the preview starts once there is a page to render.`
      : 'Waiting for the first files…';
  }
  const written = `${summary.filesWritten} ${summary.filesWritten === 1 ? 'file' : 'files'} written`;
  return summary.activePath
    ? `${written} · writing ${summary.activePath} — the preview starts once there is a page to render.`
    : `${written} — the preview starts once there is a page to render.`;
}

export function BrowserPreview({
  stack,
  files,
  stream,
  settleMs = DEFAULT_SETTLE_MS,
  className,
  onStatusChange,
}: {
  stack: string;
  /** Files already persisted for the project; the base layer. */
  files: Record<string, string>;
  /** Present only while a generation is mounted behind this pane. */
  stream?: PreviewStream | null;
  settleMs?: number;
  className?: string;
  onStatusChange?: (status: PreviewState['status']) => void;
}) {
  const [state, setState] = useState<PreviewState>({ status: 'idle' });
  const [reloadToken, setReloadToken] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const streamFiles = stream?.files;
  const streamActive = Boolean(stream?.active);
  const streamActiveRef = useRef(streamActive);

  const summary = useMemo(
    () => (streamFiles ? summarizeStreamingFiles(streamFiles) : null),
    [streamFiles],
  );

  // Completed stream files layer over the persisted ones. The trailing entry is
  // mid-write: half a module is a guaranteed esbuild failure, so it is excluded
  // rather than compiled and reported as a broken build.
  const compilable = useMemo(() => {
    if (!streamFiles || streamFiles.length === 0) return files;
    const merged = { ...files };
    for (const file of streamFiles) {
      if (file.completed) merged[file.path] = file.content;
    }
    return merged;
  }, [files, streamFiles]);

  const assembly = useMemo(() => assemblePreview(stack, compilable), [stack, compilable]);
  // A stable identity for "these exact files", so re-renders that do not change
  // the code never rebuild (esbuild-wasm on every keystroke is too slow). The
  // compile effect keys on the settled target, never on this object's identity.
  const target = useMemo<SettleTarget>(
    () => ({ key: JSON.stringify(assembly), assembly }),
    [assembly],
  );
  const [settle, dispatch] = useReducer(settleReducer, { active: target, pending: null });

  useEffect(() => {
    streamActiveRef.current = streamActive;
  }, [streamActive]);

  useEffect(() => {
    onStatusChange?.(state.status);
  }, [state.status, onStatusChange]);

  useEffect(() => {
    dispatch({ type: 'files', target, settling: streamActive });
  }, [target, streamActive]);

  useEffect(() => {
    if (!settle.pending) return;
    const timer = setTimeout(() => dispatch({ type: 'settled' }), settleMs);
    return () => clearTimeout(timer);
  }, [settle.pending, settleMs]);

  useEffect(() => {
    let cancelled = false;
    const { assembly: settled } = settle.active;

    async function run() {
      if (settled.kind === 'empty') {
        setState((prev) => emptyAssemblyState(prev, settled.reason, streamActiveRef.current));
        return;
      }

      if (settled.kind === 'html') {
        setState({
          status: 'running',
          srcdoc: buildPreviewSrcdoc({ code: '', rawHtml: settled.html }),
        });
        return;
      }

      setState((prev) => ({ status: 'bundling', srcdoc: srcdocOf(prev) }));
      const result = await bundlePreview(settled.files, settled.entry, {
        aliases: settled.aliases,
      });
      if (cancelled) return;

      if (!result.ok) {
        setState((prev) => previewError(prev, result.error));
        return;
      }
      setState({
        status: 'running',
        srcdoc: buildPreviewSrcdoc({ code: result.code, css: result.css }),
      });
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [settle.active, reloadToken]);

  useEffect(() => {
    // A stream that ends without ever producing a root component is a real dead
    // end, so the patient copy stops being true the moment the build stops.
    if (streamActive) return;
    setState((prev) =>
      prev.status === 'waiting' ? { status: 'error', message: prev.reason } : prev,
    );
  }, [streamActive]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = event.data as { source?: string; type?: string; message?: string } | null;
      if (!data || data.source !== PREVIEW_MESSAGE_SOURCE) return;
      if (data.type === 'ready') {
        clearTimeout(watchdogRef.current ?? undefined);
        setState((prev) =>
          prev.status === 'running' ? { status: 'ready', srcdoc: prev.srcdoc } : prev,
        );
        return;
      }
      if (data.type === 'error') {
        clearTimeout(watchdogRef.current ?? undefined);
        setState((prev) => previewError(prev, data.message || 'The preview hit a runtime error.'));
      }
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (state.status !== 'running') return;
    watchdogRef.current = setTimeout(() => {
      setState((prev) =>
        prev.status === 'running'
          ? previewError(
              prev,
              'The preview did not finish loading. A package import may be unavailable — check the browser console inside the frame.',
            )
          : prev,
      );
    }, READY_WATCHDOG_MS);
    return () => {
      clearTimeout(watchdogRef.current ?? undefined);
    };
  }, [state.status]);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);
  const srcdoc = srcdocOf(state);
  const bundling = state.status === 'bundling';

  return (
    <div className={cn('relative h-full w-full bg-white', className)}>
      {srcdoc ? (
        <iframe
          ref={iframeRef}
          title="Project preview"
          className="h-full w-full border-0 bg-white"
          // No allow-same-origin: the generated app must not reach this app's
          // origin, storage, or session. Everything it needs is in the srcdoc.
          sandbox="allow-scripts allow-forms allow-modals allow-popups"
          srcDoc={srcdoc}
        />
      ) : null}

      {bundling && !srcdoc ? (
        <div className="absolute inset-0 grid place-items-center bg-white/85 backdrop-blur-sm">
          <div className="flex items-center gap-8 text-[13px] text-[var(--studio-muted)]">
            <Loader2 className="size-16 animate-spin motion-reduce:animate-none" />
            Building your preview…
          </div>
        </div>
      ) : null}

      {bundling && srcdoc ? (
        // A rebuild mid-stream must not curtain off a preview that works.
        <div className="absolute bottom-12 right-12 flex items-center gap-6 rounded-full border border-[var(--studio-line)] bg-white/90 px-10 py-6 text-[12px] text-[var(--studio-muted)] shadow-sm backdrop-blur-sm">
          <Loader2 className="size-13 animate-spin motion-reduce:animate-none" />
          Rebuilding…
        </div>
      ) : null}

      {state.status === 'waiting' ? (
        <div className="absolute inset-0 grid place-items-center bg-white p-24">
          <div className="flex max-w-[420px] flex-col items-center gap-8 text-center">
            <Loader2 className="size-18 animate-spin text-[var(--studio-accent)] motion-reduce:animate-none" />
            <p className="text-[13px] text-[var(--studio-muted)]">{waitingMessage(summary)}</p>
          </div>
        </div>
      ) : null}

      {state.status === 'error' && !srcdoc ? (
        <div className="absolute inset-0 overflow-auto bg-white/95 p-24 backdrop-blur-sm">
          <div className="mx-auto flex max-w-[560px] flex-col gap-12">
            <div className="flex items-center gap-8 text-[var(--studio-fg)]">
              <AlertTriangle className="size-18 text-amber-600" />
              <h3 className="text-[15px] font-semibold">Preview couldn’t run</h3>
            </div>
            <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap rounded-[10px] bg-[var(--studio-subtle)] p-12 text-[12px] leading-5 text-[var(--studio-muted)]">
              {state.message}
            </pre>
            <button
              type="button"
              onClick={reload}
              className="inline-flex w-fit items-center gap-6 rounded-full border border-[var(--studio-line)] px-14 py-8 text-[13px] font-medium text-[var(--studio-fg)] transition-colors hover:bg-[var(--studio-subtle)]"
            >
              <RefreshCw className="size-14" />
              Try again
            </button>
          </div>
        </div>
      ) : null}

      {state.status === 'error' && srcdoc ? (
        // The last good render stays visible underneath: a broken intermediate
        // state during a stream reports itself without taking the pane away.
        <div className="absolute inset-x-0 bottom-0 max-h-[45%] overflow-auto border-t border-[var(--studio-line)] bg-white/95 p-12 backdrop-blur-sm">
          <div className="flex items-start gap-8">
            <AlertTriangle className="mt-2 size-16 shrink-0 text-amber-600" />
            <div className="flex min-w-0 flex-1 flex-col gap-8">
              <h3 className="text-[13px] font-semibold text-[var(--studio-fg)]">
                Preview couldn’t run
              </h3>
              <pre className="max-h-[160px] overflow-auto whitespace-pre-wrap text-[12px] leading-5 text-[var(--studio-muted)]">
                {state.message}
              </pre>
            </div>
            <button
              type="button"
              onClick={reload}
              className="inline-flex shrink-0 items-center gap-6 rounded-full border border-[var(--studio-line)] px-12 py-6 text-[12px] font-medium text-[var(--studio-fg)] transition-colors hover:bg-[var(--studio-subtle)]"
            >
              <RefreshCw className="size-13" />
              Try again
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
