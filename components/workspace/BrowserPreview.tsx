'use client';

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { AlertTriangle, Loader2, RefreshCw, Wand2 } from 'lucide-react';
import { assemblePreview, previewFilesKey, type PreviewAssembly } from '@/lib/preview/assemble';
import { bundlePreview } from '@/lib/preview/bundle';
import { buildPreviewSrcdoc, PREVIEW_MESSAGE_SOURCE } from '@/lib/preview/html';
import {
  explainPreviewError,
  pendingLocalModules,
  stripPreviewScheme,
  waitingForModulesMessage,
  type PreviewErrorKind,
} from '@/lib/preview/labels';
import { summarizeStreamingFiles } from '@/lib/generation/generation-runtime';
import type { GenerationFile } from '@/lib/generation/types';
import { cn } from '@/utils/cn';

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
  /**
   * Not enough code to bundle yet, or an import pointing at a file the running
   * stream has not written. Not an error: `pendingError` carries the bundler
   * failure being waited out, so it can be reported verbatim if the stream ends
   * without that file ever arriving.
   */
  | { status: 'waiting'; reason: string; srcdoc?: string; pendingError?: string }
  | { status: 'bundling'; srcdoc?: string }
  | { status: 'running'; srcdoc: string }
  | { status: 'ready'; srcdoc: string }
  | { status: 'error'; message: string; srcdoc?: string; kind?: PreviewErrorKind };

/**
 * Which recovery a failure admits. Recompiling the same files can only fail the
 * same way, so a `code` failure must never be offered as a retry; a `runtime`
 * failure — a package that never loaded, a frame that never signalled ready —
 * genuinely can pass on a second attempt.
 */
export type { PreviewErrorKind };

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
 *
 * `kind` is optional because some failures are plain-English reasons rather than
 * compiler output; the banner then assumes `code`, the reading that promises the
 * least.
 */
export function previewError(
  prev: PreviewState,
  message: string,
  kind?: PreviewErrorKind,
): PreviewState {
  return { status: 'error', message, srcdoc: srcdocOf(prev), kind };
}

/**
 * A bundler failure mid-stream is usually a half-written build, not a broken
 * one. Incident: with 16 of ~25 files streamed, `app/page.tsx` had completed and
 * imported `@/components/FinalCTA`, which had not been written yet — and the
 * pane told the user their preview was broken while the model was still typing.
 *
 * So while the stream runs, a failure whose every diagnostic names a
 * project-local module becomes patience: the last good frame stays, the pane
 * names the file it is waiting for, and the next settle window retries against
 * the newer file set. An unresolvable package is reported immediately — no
 * amount of further streaming can produce one — and once the stream ends an
 * unresolved local import is a real error too.
 */
export function bundleFailureState(
  prev: PreviewState,
  message: string,
  streaming: boolean,
): PreviewState {
  const pending = streaming ? pendingLocalModules(message) : null;
  if (!pending || pending.length === 0) return previewError(prev, message, 'code');
  return {
    status: 'waiting',
    reason: waitingForModulesMessage(pending),
    srcdoc: srcdocOf(prev),
    pendingError: message,
  };
}

/** The failure the pane reports, with the recovery it can honestly offer. */
export function errorBanner(
  state: PreviewState,
): { message: string; kind: PreviewErrorKind } | null {
  if (state.status !== 'error') return null;
  return { message: state.message, kind: state.kind ?? 'code' };
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

function BrowserPreviewImpl({
  stack,
  files,
  stream,
  settleMs = DEFAULT_SETTLE_MS,
  className,
  frameRef,
  onStatusChange,
  onFrameMounted,
  onFixError,
}: {
  stack: string;
  /** Files already persisted for the project; the base layer. */
  files: Record<string, string>;
  /** Present only while a generation is mounted behind this pane. */
  stream?: PreviewStream | null;
  settleMs?: number;
  className?: string;
  /**
   * The rendered frame, handed up so the workspace can drive Visual Edits on
   * it. This iframe is the only preview a user sees, so it is also the only
   * thing the inspector can be pointed at (F-142/F-143).
   */
  frameRef?: RefObject<HTMLIFrameElement | null>;
  onStatusChange?: (status: PreviewState['status']) => void;
  /**
   * Whether the frame is on screen right now. A ref cannot be observed, and the
   * status alone does not say: `bundling`, `waiting` and `error` all keep the
   * last good document mounted underneath. Without this the Visual Edits
   * toolbar would offer itself over a pane that has no frame in it.
   */
  onFrameMounted?: (mounted: boolean) => void;
  /**
   * Hands the failure to whoever owns the chat, so a fault the model caused can
   * be sent straight back to it. The `kind` goes with it because the instruction
   * differs: a runtime crash compiled fine, and telling the model to "fix the
   * code so it compiles" sent it looking for a build error that did not exist.
   */
  onFixError?: (message: string, kind: PreviewErrorKind) => void;
}) {
  const [state, setState] = useState<PreviewState>({ status: 'idle' });
  const [reloadToken, setReloadToken] = useState(0);
  const localFrameRef = useRef<HTMLIFrameElement>(null);
  const iframeRef = frameRef ?? localFrameRef;
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

  // The identity that decides "same code". `compilable` is a new object on every
  // chunk of a stream — `streamFiles` is a fresh array each time — so this used
  // to `JSON.stringify` the whole project per chunk to derive the key, an
  // O(project) allocation on the same thread as the streaming UI (F-642).
  // `previewFilesKey` reads the same bytes but copies nothing. The assembly still
  // rebuilds per chunk, but the settle reducer compares `target.key` and drops a
  // rebuild whose key already matches, so an unchanged file set never recompiles.
  const assembly = useMemo(() => assemblePreview(stack, compilable), [stack, compilable]);
  const target = useMemo<SettleTarget>(
    () => ({ key: `${stack}:${previewFilesKey(compilable)}`, assembly }),
    [stack, compilable, assembly],
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
        setState((prev) => bundleFailureState(prev, result.error, streamActiveRef.current));
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
    // A stream that ended without writing the file the pane was waiting for is a
    // real dead end, so the patient copy stops being true the moment the build
    // stops. `pendingError` is the bundler's own words, which the banner can
    // humanise and the chat can repair; `reason` covers the nothing-to-bundle
    // case, which has no compiler output behind it.
    if (streamActive) return;
    setState((prev) =>
      prev.status === 'waiting'
        ? previewError(prev, prev.pendingError ?? prev.reason, 'code')
        : prev,
    );
  }, [streamActive]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      // `stack` is already on the bridge's payload (`PreviewMessage`), it was
      // simply never read here.
      const data = event.data as {
        source?: string;
        type?: string;
        message?: string;
        stack?: string;
      } | null;
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
        // The stack rides along. A repair attempt given only "Cannot read
        // properties of undefined (reading 'map')" has nowhere to look and came
        // back with an edit that did not fix it; the bundle's frames still name
        // the component function, which is what makes the fault findable.
        const runtime = data.stack
          ? `${data.message || 'The preview hit a runtime error.'}\n\n${data.stack}`
          : data.message || 'The preview hit a runtime error.';
        setState((prev) => previewError(prev, runtime, 'runtime'));
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
              'runtime',
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
  const banner = errorBanner(state);

  // The pane keeps the last good document mounted through a rebuild, a wait and
  // a recoverable error, so "is there a frame" is `srcdoc`, not `status`. The
  // workspace unmounts this component when it switches away from the preview,
  // and reads its own view state for that case, so there is no unmount report
  // here to flicker the toolbar between renders.
  const frameMounted = Boolean(srcdoc);
  useEffect(() => {
    onFrameMounted?.(frameMounted);
  }, [frameMounted, onFrameMounted]);

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

      {state.status === 'waiting' && srcdoc ? (
        // Waiting on a file mid-stream must stay legible without curtaining off
        // the frame that already works, so it reads like the rebuild pill.
        <div className="absolute bottom-12 right-12 flex max-w-[70%] items-center gap-6 rounded-full border border-[var(--studio-line)] bg-white/90 px-10 py-6 text-[12px] text-[var(--studio-muted)] shadow-sm backdrop-blur-sm">
          <Loader2 className="size-13 shrink-0 animate-spin motion-reduce:animate-none" />
          <span className="truncate">{state.reason}</span>
        </div>
      ) : null}

      {state.status === 'waiting' && !srcdoc ? (
        <div className="absolute inset-0 grid place-items-center bg-white p-24">
          <div className="flex max-w-[420px] flex-col items-center gap-8 text-center">
            <Loader2 className="size-18 animate-spin text-[var(--studio-accent)] motion-reduce:animate-none" />
            <p className="text-[13px] text-[var(--studio-muted)]">
              {/* A named missing file beats generic progress copy; `reason` only
                  says that when a bundler failure is being waited out. */}
              {state.pendingError ? state.reason : waitingMessage(summary)}
            </p>
          </div>
        </div>
      ) : null}

      {banner && !srcdoc ? (
        <div className="absolute inset-0 overflow-auto bg-white/95 p-24 backdrop-blur-sm">
          <div className="mx-auto max-w-[560px]">
            <PreviewErrorReport
              message={banner.message}
              kind={banner.kind}
              onFix={onFixError}
              onReload={reload}
            />
          </div>
        </div>
      ) : null}

      {banner && srcdoc ? (
        // The last good render stays visible underneath: a broken intermediate
        // state during a stream reports itself without taking the pane away.
        <div className="absolute inset-x-0 bottom-0 max-h-[45%] overflow-auto border-t border-[var(--studio-line)] bg-white/95 p-12 backdrop-blur-sm">
          <PreviewErrorReport
            compact
            message={banner.message}
            kind={banner.kind}
            onFix={onFixError}
            onReload={reload}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Memoised for the same reason as the streaming panel: the workspace root
 * re-renders on every one of its own state changes, and this pane runs an
 * esbuild-wasm compile off its props (F-641). Its props change only when the
 * files or the stream do, so an unrelated root render no longer re-runs it.
 *
 * The caller must keep `files`, `stream` and the callbacks referentially stable
 * across renders that change none of them — an inline `stream={{…}}` object or a
 * fresh `onFixError` closure defeats this.
 */
export const BrowserPreview = memo(BrowserPreviewImpl);

/**
 * Says what each button will actually do. "Try again" on a compile failure was a
 * lie: recompiling the same files reproduces the same failure every time, which
 * is exactly what the user hit — an error, a retry, the identical error.
 */
function recoveryNote(kind: PreviewErrorKind, canFix: boolean): string {
  if (kind === 'runtime') {
    return canFix
      ? 'Try again reloads the frame and re-fetches its packages. Fix this sends the error to the chat instead.'
      : 'Try again reloads the frame and re-fetches its packages.';
  }
  return canFix
    ? 'Fix this sends the compiler output to the chat so the code can be repaired. Recompile re-reads the same files, so it only helps once the code has changed.'
    : 'Recompile re-reads the same files, so it only helps once the code has changed.';
}

/**
 * A failure a non-compiler-expert can act on: the humanised sentence first, the
 * compiler's own words one click away, and an action that can change the
 * outcome. Exported so both placements and the tests use one report.
 */
export function PreviewErrorReport({
  message,
  kind,
  compact = false,
  onFix,
  onReload,
}: {
  message: string;
  kind: PreviewErrorKind;
  /** Rendered over a working preview, so it has to stay small. */
  compact?: boolean;
  onFix?: (message: string, kind: PreviewErrorKind) => void;
  onReload: () => void;
}) {
  const sentences = explainPreviewError(message);
  // Two separate guarantees: `bundlePreview` strips the `vfs:` namespace from the
  // message itself (so the chat handoff never mentions it either), and this strips
  // it again on the way to the screen, so no caller can put our own virtual
  // filesystem scheme in front of a reader.
  const compilerOutput = stripPreviewScheme(message);
  const rawClassName = cn(
    'overflow-auto whitespace-pre-wrap rounded-[10px] bg-[var(--studio-subtle)] p-12 text-[12px] leading-5 text-[var(--studio-muted)]',
    compact ? 'max-h-[120px]' : 'max-h-[280px]',
  );

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center gap-8 text-[var(--studio-fg)]">
        <AlertTriangle className={cn('shrink-0 text-amber-600', compact ? 'size-16' : 'size-18')} />
        <h3 className={cn('font-semibold', compact ? 'text-[13px]' : 'text-[15px]')}>
          Preview couldn’t run
        </h3>
      </div>

      {sentences.map((sentence) => (
        <p key={sentence} className="text-[13px] leading-5 text-[var(--studio-fg)]">
          {sentence}
        </p>
      ))}

      {sentences.length > 0 ? (
        // Collapsed, not dropped: whoever wants the compiler's exact words can
        // still copy them, and everyone else no longer has to read them first.
        <details className="text-[12px] text-[var(--studio-muted)]">
          <summary className="w-fit cursor-pointer select-none">
            {kind === 'runtime' ? 'Error details' : 'Compiler output'}
          </summary>
          <pre className={cn('mt-6', rawClassName)}>{compilerOutput}</pre>
        </details>
      ) : (
        <pre className={rawClassName}>{compilerOutput}</pre>
      )}

      <div className="flex flex-wrap items-center gap-8">
        {onFix ? (
          <button
            type="button"
            data-preview-action="fix"
            onClick={() => onFix(message, kind)}
            className="inline-flex items-center gap-6 rounded-full [background-image:var(--studio-cta-gradient)] px-14 py-8 text-[13px] font-medium text-[var(--studio-cta-fg)] transition-[filter] hover:brightness-[1.07] motion-reduce:transition-none"
          >
            <Wand2 className="size-14" />
            Fix this
          </button>
        ) : null}
        <button
          type="button"
          data-preview-action="reload"
          onClick={onReload}
          className="inline-flex items-center gap-6 rounded-full border border-[var(--studio-line)] px-14 py-8 text-[13px] font-medium text-[var(--studio-fg)] transition-colors hover:bg-[var(--studio-subtle)]"
        >
          <RefreshCw className="size-14" />
          {kind === 'runtime' ? 'Try again' : 'Recompile'}
        </button>
      </div>

      <p className="text-[12px] leading-5 text-[var(--studio-muted)]">
        {recoveryNote(kind, Boolean(onFix))}
      </p>
    </div>
  );
}
