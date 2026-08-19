'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isChatRecoveryStatus, isJobSettled } from '@/lib/jobs/chat-ui';
import { nextPollIntervalMs, shouldStopClientPoll } from '@/lib/jobs/poll';
import type { PublicGenerationJob } from '@/lib/jobs/types';

export function useGenerationJob({
  projectId,
  phase,
  isJobActive,
}: {
  projectId: string | null;
  phase?: string | null;
  isJobActive?: boolean;
}) {
  const [job, setJob] = useState<PublicGenerationJob | null>(null);
  const [clientStop, setClientStop] = useState<'timeout' | 'stale_heartbeat' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const startedAtRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) return null;
    const response = await fetch(`/api/projects/${projectId}/job`);
    if (!response.ok) return null;
    const data = (await response.json()) as { job?: PublicGenerationJob | null };
    const next = data.job ?? null;
    setJob(next);
    return next;
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    void refresh();
  }, [projectId, refresh]);

  const shouldPoll =
    Boolean(projectId) &&
    !clientStop &&
    (phase === 'BUILDING' || job?.status === 'QUEUED' || job?.status === 'RUNNING' || isJobActive);

  useEffect(() => {
    if (!shouldPoll) return;
    if (!startedAtRef.current) startedAtRef.current = Date.now();
    let timer: number | null = null;
    let cancelled = false;

    const tick = async () => {
      const next = await refresh();
      if (cancelled) return;
      // Settled first: the job's own end state is the answer, and asking the
      // watchdog about a job that already finished only invents a failure —
      // its heartbeat stopped when it ended, so it is stale by definition.
      if (isJobSettled(next?.status)) {
        setClientStop(null);
        return;
      }
      const stop = shouldStopClientPoll({
        startedAtMs: startedAtRef.current ?? Date.now(),
        heartbeatAt: next?.heartbeatAt ?? null,
      });
      if (stop) {
        setClientStop(stop);
        return;
      }
      const elapsed = Date.now() - (startedAtRef.current ?? Date.now());
      timer = window.setTimeout(() => {
        void tick();
      }, nextPollIntervalMs(elapsed));
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [refresh, shouldPoll]);

  /**
   * Catch up the moment the tab is looked at again.
   *
   * Browsers throttle timers in background tabs to a minute or more, so a
   * build watched from another tab polls far too slowly to see it finish —
   * the person comes back to a spinner, or to a stale-heartbeat verdict on
   * work that succeeded while they were away. Waiting is the normal thing to
   * do while a site builds, so returning has to re-read the truth.
   */
  useEffect(() => {
    if (!projectId) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [projectId, refresh]);

  // A watchdog stop only means "we stopped watching". If the job has since
  // settled, its status decides — a SUCCEEDED build must never show recovery.
  const recovery = isJobSettled(job?.status)
    ? isChatRecoveryStatus(job?.status)
    : clientStop !== null;

  const act = useCallback(
    async (action: 'keep' | 'retry' | 'start-over', body?: Record<string, unknown>) => {
      if (!projectId) return { ok: false as const, error: 'Project is not ready' };
      setBusy(action === 'start-over' ? 'start-over' : action);
      try {
        const response = await fetch(`/api/projects/${projectId}/job/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        });
        const data = (await response.json().catch(() => ({}))) as {
          prompt?: string;
          resume?: boolean;
          error?: { message?: string } | string;
        };
        if (!response.ok) {
          const message =
            typeof data.error === 'string'
              ? data.error
              : data.error?.message || 'Could not recover the build';
          return { ok: false as const, error: message };
        }
        setClientStop(null);
        startedAtRef.current = Date.now();
        await refresh();
        return { ok: true as const, prompt: data.prompt, resume: data.resume };
      } finally {
        setBusy(null);
      }
    },
    [projectId, refresh],
  );

  return {
    job,
    recovery,
    clientStop,
    busy,
    refresh,
    keep: () => act('keep'),
    retry: (idempotencyKey?: string) => act('retry', { idempotencyKey }),
    startOver: () => act('start-over'),
  };
}
