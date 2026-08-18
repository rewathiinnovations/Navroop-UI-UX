'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { assemblePreview } from '@/lib/preview/assemble';
import { bundlePreview } from '@/lib/preview/bundle';
import { buildPreviewSrcdoc, PREVIEW_MESSAGE_SOURCE } from '@/lib/preview/html';
import { cn } from '@/lib/utils';

/**
 * Renders a generated project entirely in the browser: esbuild-wasm bundles the
 * files, esm.sh serves the runtime dependencies, and the result runs in a
 * sandboxed iframe. No sandbox VM, no dev server, no network round trip.
 */

type PreviewState =
  | { status: 'idle' }
  | { status: 'bundling' }
  | { status: 'running'; srcdoc: string }
  | { status: 'ready'; srcdoc: string }
  | { status: 'error'; message: string; srcdoc?: string };

/** A module that never loads fires no error anywhere; without this the frame hangs blank. */
const READY_WATCHDOG_MS = 15_000;

export function BrowserPreview({
  stack,
  files,
  className,
  onStatusChange,
}: {
  stack: string;
  files: Record<string, string>;
  className?: string;
  onStatusChange?: (status: PreviewState['status']) => void;
}) {
  const [state, setState] = useState<PreviewState>({ status: 'idle' });
  const [reloadToken, setReloadToken] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const assembly = useMemo(() => assemblePreview(stack, files), [stack, files]);
  // A stable identity for "these exact files", so re-renders that do not change
  // the code never rebuild (esbuild-wasm on every keystroke is too slow).
  const filesKey = useMemo(() => JSON.stringify(assembly), [assembly]);

  useEffect(() => {
    onStatusChange?.(state.status);
  }, [state.status, onStatusChange]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (assembly.kind === 'empty') {
        setState({ status: 'error', message: assembly.reason });
        return;
      }

      if (assembly.kind === 'html') {
        setState({
          status: 'running',
          srcdoc: buildPreviewSrcdoc({ code: '', rawHtml: assembly.html }),
        });
        return;
      }

      setState({ status: 'bundling' });
      const result = await bundlePreview(assembly.files, assembly.entry, {
        aliases: assembly.aliases,
      });
      if (cancelled) return;

      if (!result.ok) {
        setState({ status: 'error', message: result.error });
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
  }, [assembly, filesKey, reloadToken]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = event.data as { source?: string; type?: string; message?: string } | null;
      if (!data || data.source !== PREVIEW_MESSAGE_SOURCE) return;
      if (data.type === 'ready') {
        if (watchdogRef.current) clearTimeout(watchdogRef.current);
        setState((prev) =>
          prev.status === 'running' ? { status: 'ready', srcdoc: prev.srcdoc } : prev,
        );
        return;
      }
      if (data.type === 'error') {
        if (watchdogRef.current) clearTimeout(watchdogRef.current);
        setState((prev) => ({
          status: 'error',
          message: data.message || 'The preview hit a runtime error.',
          srcdoc: 'srcdoc' in prev ? prev.srcdoc : undefined,
        }));
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
          ? {
              status: 'error',
              message:
                'The preview did not finish loading. A package import may be unavailable — check the browser console inside the frame.',
              srcdoc: prev.srcdoc,
            }
          : prev,
      );
    }, READY_WATCHDOG_MS);
    return () => {
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
    };
  }, [state.status]);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);
  const srcdoc = 'srcdoc' in state ? state.srcdoc : undefined;
  const busy = state.status === 'bundling';

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

      {busy ? (
        <div className="absolute inset-0 grid place-items-center bg-white/85 backdrop-blur-sm">
          <div className="flex items-center gap-8 text-[13px] text-[var(--studio-muted)]">
            <Loader2 className="size-16 animate-spin motion-reduce:animate-none" />
            Building your preview…
          </div>
        </div>
      ) : null}

      {state.status === 'error' ? (
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
    </div>
  );
}
