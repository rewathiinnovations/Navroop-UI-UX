'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PreviewBuildStatus, PreviewMode } from '@/lib/preview/types';
import { PREVIEW_ACCESS_DENIED, PREVIEW_NOT_READY_NOTICE } from '@/lib/preview/labels';
import { notify } from '@/lib/notify';

export type StaticPreviewState = {
  mode: PreviewMode;
  status: PreviewBuildStatus | null;
  previewUrl: string | null;
  buildLog: string | null;
  error: string | null;
  lockedLive: boolean;
  liveReason: string | null;
  preparing: boolean;
};

const EMPTY: StaticPreviewState = {
  mode: 'STATIC',
  status: null,
  previewUrl: null,
  buildLog: null,
  error: null,
  lockedLive: false,
  liveReason: null,
  preparing: false,
};

type StatusResponse = Partial<StaticPreviewState> & { lastReadyUrl?: string | null };

export function useStaticPreview({
  projectId,
  enabled,
  iframeRef,
  selectedPage = '/',
}: {
  projectId: string | null;
  enabled: boolean;
  iframeRef?: { current: HTMLIFrameElement | null };
  selectedPage?: string;
}) {
  const [state, setState] = useState<StaticPreviewState>(EMPTY);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /**
   * A 403 from the preview route is terminal. Project reads are workspace-wide,
   * but minting a preview token is owner/ADMIN only because the signed URL it
   * returns is spendable anonymously on `/preview-static`. Polling through that
   * refusal would only be a slower version of the loop a failed build used to
   * cause, so the first 403 stops the status poll and the token refresher.
   *
   * The ref holds the refused projectId rather than a boolean: the workspace
   * keeps this hook mounted across an in-app project switch, and a boolean
   * would carry project A's refusal over and kill B's preview too.
   */
  const deniedRef = useRef<string | null>(null);

  /**
   * Being refused has to be said out loud. Stopping the poll on its own left
   * the panel on PREVIEW_EMPTY ("nothing to preview yet"), so a preview refused
   * because the caller does not own the project was indistinguishable from one
   * that was merely slow. The sentence is local copy, not `data.error`: the
   * route answers a bare `{ error: 'Forbidden' }`, which is a status word and
   * not something to show a user. One `key` per project, because the status
   * read and the token refresher can both be refused — the second refusal then
   * updates the same toast instead of stacking a duplicate.
   */
  const denyPreview = useCallback((refusedProjectId: string) => {
    deniedRef.current = refusedProjectId;
    notify.error(PREVIEW_ACCESS_DENIED, { key: `preview-denied-${refusedProjectId}` });
  }, []);

  const applyUrl = useCallback(
    (url: string | null) => {
      if (!url || !iframeRef?.current) return;
      try {
        const next = new URL(url, window.location.origin);
        if (selectedPage && selectedPage !== '/') {
          const suffix = selectedPage.startsWith('/') ? selectedPage : `/${selectedPage}`;
          next.pathname = next.pathname.replace(/\/$/, '') + suffix;
        }
        const href = next.toString();
        if (iframeRef.current.src !== href) iframeRef.current.src = href;
      } catch {
        if (iframeRef.current.src !== url) iframeRef.current.src = url;
      }
    },
    [iframeRef, selectedPage],
  );

  const refresh = useCallback(async () => {
    if (!projectId || deniedRef.current === projectId) return EMPTY;
    const response = await fetch(`/api/projects/${projectId}/preview`);
    if (response.status === 403) {
      denyPreview(projectId);
      setState(EMPTY);
      return EMPTY;
    }
    const data = (await response.json().catch(() => ({}))) as StatusResponse;
    const next: StaticPreviewState = {
      mode: data.mode ?? 'STATIC',
      status: data.status ?? null,
      previewUrl: data.previewUrl ?? data.lastReadyUrl ?? null,
      buildLog: data.buildLog ?? null,
      error: data.error ?? null,
      lockedLive: Boolean(data.lockedLive),
      liveReason: data.liveReason ?? null,
      preparing: Boolean(data.preparing),
    };
    setState(next);
    return next;
  }, [denyPreview, projectId]);

  /**
   * "Try again" on a failed preview build. It used to post `action: 'retry'`,
   * which went away with the sandbox VMs — the route answers `400 Unknown
   * action` and the response was never inspected, so the button was a silent
   * no-op indistinguishable from a hung UI. The route implements `token`, so
   * what Try again can still do is re-mint a preview URL and re-read the build
   * row: a snapshot captured by a later generation shows up here. A build that
   * is still FAILED now says so instead of re-rendering the same panel.
   */
  const retry = useCallback(async () => {
    if (!projectId) return;
    const response = await fetch(`/api/projects/${projectId}/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'token', path: selectedPage }),
    });
    const data = (await response.json().catch(() => ({}))) as {
      previewUrl?: string;
      error?: string;
    };
    if (!response.ok) {
      notify.error(data.error, {
        fallback: 'Could not refresh the preview',
        key: `preview-retry-${projectId}`,
      });
      return;
    }
    const next = await refresh();
    applyUrl(data.previewUrl ?? next.previewUrl);
    if (next.status === 'FAILED') {
      notify.error(next.error, {
        fallback: PREVIEW_NOT_READY_NOTICE,
        key: `preview-retry-${projectId}`,
      });
    }
    return next;
  }, [applyUrl, projectId, refresh, selectedPage]);

  const issueTokenUrl = useCallback(
    async (path = '/') => {
      if (!projectId || deniedRef.current === projectId) return null;
      const response = await fetch(`/api/projects/${projectId}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'token', path }),
      });
      if (response.status === 403) {
        denyPreview(projectId);
        return null;
      }
      const data = (await response.json().catch(() => ({}))) as { previewUrl?: string };
      return data.previewUrl ?? null;
    },
    [denyPreview, projectId],
  );

  useEffect(() => {
    if (!projectId || !enabled) return;
    let cancelled = false;
    void refresh().then((next) => {
      if (cancelled || !next) return;
      if (next.previewUrl) applyUrl(next.previewUrl);
    });
    return () => {
      cancelled = true;
    };
  }, [applyUrl, enabled, projectId, refresh]);

  useEffect(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (!projectId || !enabled || !state.preparing) return;
    pollRef.current = setInterval(() => {
      void refresh().then((next) => {
        if (next?.previewUrl) applyUrl(next.previewUrl);
      });
    }, 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [applyUrl, enabled, projectId, refresh, state.preparing]);

  useEffect(() => {
    if (!enabled || !state.previewUrl) return;
    applyUrl(state.previewUrl);
  }, [applyUrl, enabled, selectedPage, state.previewUrl]);

  useEffect(() => {
    if (!projectId || !enabled) return;
    const timer = setInterval(
      () => {
        void issueTokenUrl(selectedPage).then((url) => {
          if (url) applyUrl(url);
        });
      },
      90 * 60 * 1000,
    );
    return () => clearInterval(timer);
  }, [applyUrl, enabled, issueTokenUrl, projectId, selectedPage]);

  return { ...state, refresh, retry, issueTokenUrl };
}
