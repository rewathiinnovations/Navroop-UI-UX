'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { noticeForLiveModeStart } from '@/lib/preview/after-generation';
import { LIVE_MODE_EXPIRED_NOTICE } from '@/lib/preview/labels';

const LIVE_IDLE_MS = 20 * 60 * 1000;
const HEARTBEAT_MS = 30_000;

export function useLivePreviewMode({
  projectId,
  lockedOn,
}: {
  projectId: string | null;
  lockedOn: boolean;
}) {
  const [enabled, setEnabled] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const beatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimers = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (beatRef.current) clearInterval(beatRef.current);
    timerRef.current = null;
    beatRef.current = null;
  };

  const heartbeat = useCallback(async () => {
    if (!projectId) return;
    await fetch(`/api/projects/${projectId}/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'heartbeat' }),
    });
  }, [projectId]);

  const startLive = useCallback(async () => {
    if (!projectId) return;
    setNotice(null);
    const response = await fetch(`/api/projects/${projectId}/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'live', enabled: true }),
    });
    if (!response.ok) {
      setNotice(noticeForLiveModeStart(false));
      return false;
    }
    setEnabled(true);
    return true;
  }, [projectId]);

  const stopLive = useCallback(
    async (expired = false) => {
      if (!projectId) return;
      clearTimers();
      setEnabled(false);
      await fetch(`/api/projects/${projectId}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'live', enabled: false }),
      });
      if (expired) {
        setNotice(LIVE_MODE_EXPIRED_NOTICE);
      }
    },
    [projectId],
  );

  useEffect(() => {
    if (lockedOn) {
      setEnabled(true);
      void startLive();
    }
  }, [lockedOn, startLive]);

  useEffect(() => {
    clearTimers();
    if (!enabled || !projectId) return;
    void heartbeat();
    beatRef.current = setInterval(() => {
      void heartbeat();
    }, HEARTBEAT_MS);
    if (!lockedOn) {
      timerRef.current = setTimeout(() => {
        void stopLive(true);
      }, LIVE_IDLE_MS);
    }
    return clearTimers;
  }, [enabled, heartbeat, lockedOn, projectId, stopLive]);

  const toggle = useCallback(async () => {
    if (lockedOn) return;
    if (enabled) await stopLive(false);
    else await startLive();
  }, [enabled, lockedOn, startLive, stopLive]);

  return { enabled: enabled || lockedOn, lockedOn, notice, toggle, startLive, stopLive };
}
