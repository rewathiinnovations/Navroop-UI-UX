'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PreviewBuildStatus, PreviewMode } from '@/lib/preview/types';

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
    if (!projectId) return EMPTY;
    const response = await fetch(`/api/projects/${projectId}/preview`);
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
  }, [projectId]);

  const retry = useCallback(async () => {
    if (!projectId) return;
    await fetch(`/api/projects/${projectId}/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'retry' }),
    });
    return refresh();
  }, [projectId, refresh]);

  const issueTokenUrl = useCallback(
    async (path = '/') => {
      if (!projectId) return null;
      const response = await fetch(`/api/projects/${projectId}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'token', path }),
      });
      const data = (await response.json().catch(() => ({}))) as { previewUrl?: string };
      return data.previewUrl ?? null;
    },
    [projectId],
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
    const timer = setInterval(() => {
      void issueTokenUrl(selectedPage).then((url) => {
        if (url) applyUrl(url);
      });
    }, 90 * 60 * 1000);
    return () => clearInterval(timer);
  }, [applyUrl, enabled, issueTokenUrl, projectId, selectedPage]);

  return { ...state, refresh, retry, issueTokenUrl };
}
