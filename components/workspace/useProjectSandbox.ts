'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isSandboxChatLocked } from '@/lib/jobs/chat-ui';
import { shouldRequestSandbox } from '@/lib/workspace/sandbox-request';
import type { ProjectPhase } from './types';

export type WorkspaceSandboxStatus = 'NONE' | 'BOOTING' | 'READY' | 'DEAD' | 'FAILED';
export type WorkspaceBootStep = 'probe' | 'create' | 'checkpoint' | 'restore' | 'install' | 'dev' | 'ready';

export type ProjectSandboxState = {
  status: WorkspaceSandboxStatus;
  previewUrl: string | null;
  bootStep: WorkspaceBootStep | null;
  failedStep: WorkspaceBootStep | null;
  error: string | null;
  requestId: string | null;
  hasCheckpoint: boolean;
  busy: boolean;
};

const EMPTY: ProjectSandboxState = {
  status: 'NONE',
  previewUrl: null,
  bootStep: null,
  failedStep: null,
  error: null,
  requestId: null,
  hasCheckpoint: false,
  busy: false,
};

type StatusResponse = {
  status?: WorkspaceSandboxStatus;
  previewUrl?: string | null;
  bootStep?: WorkspaceBootStep | null;
  failedStep?: WorkspaceBootStep | null;
  error?: string | null;
  requestId?: string | null;
  hasCheckpoint?: boolean;
  code?: string;
  step?: WorkspaceBootStep;
};

function asState(data: StatusResponse, fallback: ProjectSandboxState): ProjectSandboxState {
  return {
    status: data.status ?? fallback.status,
    previewUrl: data.previewUrl ?? fallback.previewUrl,
    bootStep: data.bootStep ?? null,
    failedStep: data.failedStep ?? data.step ?? null,
    error: data.error ?? fallback.error,
    requestId: data.requestId ?? fallback.requestId,
    hasCheckpoint: Boolean(data.hasCheckpoint ?? fallback.hasCheckpoint),
    busy: (data.status ?? fallback.status) === 'BOOTING',
  };
}

export function useProjectSandbox({
  projectId,
  phase,
  iframeRef,
  liveMode = false,
}: {
  projectId: string | null;
  phase?: ProjectPhase | null;
  iframeRef?: { current: HTMLIFrameElement | null };
  liveMode?: boolean;
}) {
  const [state, setState] = useState<ProjectSandboxState>(EMPTY);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const applyReadyUrl = useCallback(
    (url: string | null) => {
      if (!url || !iframeRef?.current) return;
      const current = iframeRef.current.src || '';
      if (!current.includes(url)) iframeRef.current.src = url;
    },
    [iframeRef],
  );

  const refresh = useCallback(async () => {
    if (!projectId) return EMPTY;
    const response = await fetch(`/api/projects/${projectId}/sandbox`);
    const data = (await response.json().catch(() => ({}))) as StatusResponse;
    const next = asState(data, EMPTY);
    setState(next);
    if (liveMode && next.status === 'READY') applyReadyUrl(next.previewUrl);
    return next;
  }, [applyReadyUrl, liveMode, projectId]);

  const boot = useCallback(async () => {
    if (!projectId) return;
    setState((prev) => ({ ...prev, status: 'BOOTING', busy: true, error: null, failedStep: null }));
    const response = await fetch(`/api/projects/${projectId}/sandbox`, { method: 'POST' });
    const data = (await response.json().catch(() => ({}))) as StatusResponse & { previewUrl?: string };
    if (!response.ok) {
      const next: ProjectSandboxState = {
        status: 'FAILED',
        previewUrl: null,
        bootStep: null,
        failedStep: data.step ?? data.failedStep ?? 'create',
        error: data.error || 'Sandbox boot failed',
        requestId: data.requestId ?? null,
        hasCheckpoint: Boolean(data.hasCheckpoint),
        busy: false,
      };
      setState(next);
      return next;
    }
    const next = asState({ ...data, status: data.status ?? 'READY', previewUrl: data.previewUrl }, EMPTY);
    setState({ ...next, busy: false });
    if (liveMode) applyReadyUrl(next.previewUrl);
    return next;
  }, [applyReadyUrl, liveMode, projectId]);

  useEffect(() => {
    if (!projectId) {
      setState(EMPTY);
      return;
    }
    let cancelled = false;
    void (async () => {
      const current = await refresh();
      if (cancelled || !current) return;
      if (!liveMode || !shouldRequestSandbox('live')) return;
      const shouldBoot =
        current.hasCheckpoint &&
        current.status !== 'READY' &&
        current.status !== 'BOOTING' &&
        phase !== 'PLANNING';
      if (shouldBoot || current.status === 'DEAD' || current.status === 'FAILED') {
        if (current.status === 'FAILED' && !current.hasCheckpoint) return;
        if (shouldBoot || current.status === 'DEAD') await boot();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [boot, liveMode, phase, projectId, refresh]);

  useEffect(() => {
    stopPoll();
    if (!projectId || state.status !== 'BOOTING') return;
    pollRef.current = setInterval(() => {
      void refresh();
    }, 2000);
    return stopPoll;
  }, [projectId, refresh, state.status]);

  const chatLocked = isSandboxChatLocked(state.status);

  return { ...state, boot, refresh, chatLocked };
}
