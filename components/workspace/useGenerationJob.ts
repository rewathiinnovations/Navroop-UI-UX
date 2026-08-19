'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isChatRecoveryStatus, isJobSettled } from '@/lib/jobs/chat-ui';
import { CLIENT_POLL_CEILING_MS, nextPollIntervalMs, shouldStopClientPoll } from '@/lib/jobs/poll';
import type { PublicGenerationJob } from '@/lib/jobs/types';

/**
 * The clock the poll ceiling and the backoff run on: the later of "when this
 * watch began" and "when the job being watched started".
 *
 * It used to be one `startedAtRef` set on the first poll of the mount and never
 * cleared, so it measured the age of the *workspace*, not of the build. A tab
 * left open for 25 minutes — ordinary in a builder — then hit
 * CLIENT_POLL_CEILING_MS on the first poll of its next message and opened the
 * recovery panel on a build one second old. Taking the later of the two values
 * also keeps a retry honest: the retried row's own createdAt can be hours old,
 * and reading that alone would time the build out before it ran.
 */
export function watchStartedAtMs(
  job: Pick<PublicGenerationJob, 'startedAt' | 'createdAt'> | null | undefined,
  watchStartedMs: number,
): number {
  const stamp = job?.startedAt ?? job?.createdAt ?? null;
  const jobMs = stamp ? new Date(stamp).getTime() : Number.NaN;
  return Number.isNaN(jobMs) ? watchStartedMs : Math.max(watchStartedMs, jobMs);
}

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
    // A watch, not the mount: the cleanup below clears this again so the next
    // build is timed from its own beginning. `act` may have stamped it already.
    startedAtRef.current ??= Date.now();
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
      const startedAtMs = watchStartedAtMs(next, startedAtRef.current ?? Date.now());
      // A QUEUED build has no heartbeat at all — the first one is written when it starts
      // — so handing it to the watchdog called every queued build stale on the very first
      // poll and opened the recovery panel on work that had not begun. Waiting for a
      // provider slot is legitimate (up to the queue's own ten-minute timeout, which
      // settles the job), so only the poll ceiling applies while it waits.
      const stop =
        next?.status === 'QUEUED'
          ? Date.now() - startedAtMs >= CLIENT_POLL_CEILING_MS
            ? ('timeout' as const)
            : null
          : shouldStopClientPoll({
              startedAtMs,
              heartbeatAt: next?.heartbeatAt ?? null,
            });
      if (stop) {
        setClientStop(stop);
        return;
      }
      timer = window.setTimeout(
        () => {
          void tick();
        },
        nextPollIntervalMs(Date.now() - startedAtMs),
      );
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      // Stop measuring: the next watch is a different build. Leaving this set is
      // what turned a long-open workspace into an instant "timeout".
      startedAtRef.current = null;
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
      // Name the job this panel is showing. The routes used to resolve their own target
      // from the project's newest job, so a click against a panel drawn seconds earlier hit
      // whatever had started since — "start over" cancelled a running publish. When the
      // watchdog opened the panel there may be no job object to name; the server then falls
      // back to the newest chat job only, so a publish still cannot be hit from here.
      const jobId = job?.id ?? null;
      setBusy(action === 'start-over' ? 'start-over' : action);
      try {
        const response = await fetch(`/api/projects/${projectId}/job/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...(jobId ? { jobId } : {}), ...(body ?? {}) }),
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
          // The likely rejection is a stale target, so the job this panel holds is not the
          // one to retry. Re-read before returning or the buttons stay pointed at it.
          await refresh();
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
    [job?.id, projectId, refresh],
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
