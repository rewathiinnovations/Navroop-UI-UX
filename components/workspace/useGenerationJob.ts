'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isChatRecoveryStatus,
  isJobInFlight,
  isJobSettled,
  showsChatRecovery,
} from '@/lib/jobs/chat-ui';
import {
  CLIENT_POLL_CEILING_MS,
  nextPollIntervalMs,
  POLL_FAST_MS,
  shouldStopClientPoll,
  watchdogStopIsStale,
} from '@/lib/jobs/poll';
import {
  connectionState,
  isNetworkFailure,
  reportNetworkFailure,
  reportNetworkSuccess,
} from '@/lib/net/connection';
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

/**
 * Whether arming the watch should spend a request right now.
 *
 * The poll effect's first act is `void tick()`, so every re-run of it costs a
 * `GET /api/projects/{id}/job` whatever the job is doing — six of them landed in
 * a 34-second window on a workspace whose build had already SUCCEEDED. A settled
 * row is final: `tick` reads it, `isJobSettled` bails, and nothing is scheduled,
 * so that request can only re-read the row this hook is already holding.
 *
 * Two cases still have to fetch. The held row belongs to whichever project was
 * last polled, so after a switch it describes someone else's build; and a stream
 * running in this tab is newer than any row polled so far — the previous build's
 * SUCCEEDED sits in front of a job that has just started, which is the same
 * staleness `activeJob` below exists to hide.
 */
export function shouldFetchOnWatchStart(input: {
  projectId: string | null;
  heldProjectId: string | null;
  heldStatus?: string | null;
  /** A stream in this tab that the row in hand does not account for — `streamOutrunsHeldRow`. */
  isJobActive?: boolean;
  /**
   * The watch was already armed for this project on the effect's previous run.
   * False is a watch opening — phase reaching BUILDING, a project switch, a
   * mount — where the row this hook holds says nothing about the work that just
   * started, so it must read.
   */
  alreadyArmed: boolean;
}): boolean {
  if (!input.projectId) return false;
  if (!input.alreadyArmed) return true;
  if (input.isJobActive) return true;
  if (input.heldProjectId !== input.projectId) return true;
  return !isJobSettled(input.heldStatus);
}

/**
 * Whether the chat should be showing the recovery panel rather than a build.
 *
 * Two gates, and both were missing. The kind gate: a row of a kind chat never started
 * says nothing about the build, and the auto quality scan files a settled AUDIT row after
 * every successful build — a scan that failed (one provider 429 is enough) is FAILED, so
 * `isChatRecoveryStatus` said "recovery" about a build that had succeeded. Nothing showed
 * for it either, because `ProjectWorkspace` gates the panel itself on
 * `showsChatRecovery`; all it did was hold `isGenerating` false, so from then on every
 * follow-up ran with no building indicator, no file name and no elapsed clock — the exact
 * symptom `activeJob` exists to prevent, with no panel to explain it.
 *
 * And the row read has to be the masked one. A settled row belongs to the turn that
 * finished: judging the next turn by the previous turn's FAILED build reopens recovery
 * over a build that has already started in this tab.
 *
 * A null job still defers to the watchdog — the recovery UI opens on a heartbeat gap with
 * no job object at all, which is a normal state and not a missing row.
 */
export function chatRecoveryVerdict(input: {
  job: { kind?: string | null; status?: string | null } | null | undefined;
  clientStop: 'timeout' | 'stale_heartbeat' | null;
}): boolean {
  const chatJob = showsChatRecovery(input.job?.kind) ? input.job : null;
  return isJobSettled(chatJob?.status)
    ? isChatRecoveryStatus(chatJob?.status)
    : input.clientStop !== null;
}

/**
 * Whether the stream this tab claims to be running is still ahead of the row in hand.
 *
 * `isJobActive` is the generation runtime's own status (`generating` / `applying`), and every
 * guard below treats it as "a settled row cannot be describing this work, so keep reading".
 * That is true of a stream that has only just started — the previous turn's SUCCEEDED sits in
 * front of a job the server has not created yet — and it is what `activeJob` exists to hide
 * from the chat. It is *not* true once the runtime is simply stuck: measured on the running
 * app, a COMPLETE project whose BUILD had SUCCEEDED issued `GET /api/projects/{id}/job` eleven
 * times in forty seconds, one per window `focus` (the preview iframe hands focus back on its
 * own), because the flag alone held all three guards open on a row that could never change.
 *
 * The row's identity settles it, and no clock is involved. A settled row this hook was already
 * holding when the stream began ended before the stream did, so it says nothing about it; any
 * other settled row is the stream's own outcome and the flag is merely uncleared. A row still
 * in flight, or no row at all, is never a contradiction — the stream stays ahead of it.
 */
export function streamOutrunsHeldRow(input: {
  /** The generation runtime's status, as the workspace passes it. */
  isJobActive?: boolean;
  jobId?: string | null;
  jobStatus?: string | null;
  /** The row this hook held when the stream began; null when it held none. */
  rowIdWhenStreamBegan?: string | null;
}): boolean {
  if (!input.isJobActive) return false;
  if (!isJobSettled(input.jobStatus)) return true;
  return Boolean(input.jobId) && input.jobId === input.rowIdWhenStreamBegan;
}

/**
 * Whether the row on screen is still expected to change under us — the one condition every
 * request this hook makes on its own is gated by, the single opening read per project aside.
 *
 * A strict boolean, deliberately. `isJobActive` is optional, so the `||` chain this replaces
 * answered `undefined` for a caller that left it out, and `undefined` and `false` are
 * different values to a dependency array: a parent alternating between them re-ran the poll
 * effect, and a re-run that reads as a newly armed watch spends a `GET /api/projects/{id}/job`
 * before it has looked at anything.
 */
export function jobWatchIsLive(input: {
  projectId: string | null;
  clientStop: 'timeout' | 'stale_heartbeat' | null;
  phase?: string | null;
  jobStatus?: string | null;
  /** A stream in this tab that the row in hand does not account for — `streamOutrunsHeldRow`. */
  isJobActive?: boolean;
}): boolean {
  if (!input.projectId) return false;
  if (input.clientStop) return false;
  return (
    input.phase === 'BUILDING' || isJobInFlight(input.jobStatus) || Boolean(input.isJobActive)
  );
}

/**
 * Whether a tab coming back into view should spend a read.
 *
 * The catch-up exists because a background tab's timers are throttled to a minute or more, so
 * a build watched from elsewhere polls far too slowly to see it finish. It used to be bound
 * for the life of the workspace and gated on nothing but `visibilityState` — and it listens
 * for window `focus` as well as `visibilitychange`, which the preview iframe taking focus back
 * fires on its own — so a finished project kept issuing `GET /api/projects/{id}/job` for as
 * long as it stayed open: 11 of them in 40 seconds on a COMPLETE project whose BUILD had
 * SUCCEEDED, with no interval in the code to account for the cadence and no other endpoint
 * touched. `useProjectPlan` binds the same pair of listeners behind its own poll condition,
 * which is why its three requests were absent from the same capture.
 *
 * Three refusals, and a settled job in a finished project trips all three: nothing is being
 * watched, the row in hand is final, and a read now would beat the poll's own interval. A
 * stream this tab is running overrides the second, because that row is older than the work —
 * but only for as long as it really is older, which is what `streamOutrunsHeldRow` decides.
 * The raw runtime flag was enough to reopen this on its own, and that is the leak the
 * eleven-requests-in-forty-seconds survived into: the second capture was made on a COMPLETE
 * project whose BUILD had SUCCEEDED with a `finishedAt`, so the first two refusals both held
 * and the override alone bought every one of those reads.
 */
export function shouldCatchUpOnVisible(input: {
  visible: boolean;
  /** `jobWatchIsLive`: something is expected to change. */
  watching: boolean;
  /** The status this hook holds for the project on screen, `null` when it holds none. */
  heldStatus?: string | null;
  /** A stream in this tab that the row in hand does not account for — `streamOutrunsHeldRow`. */
  isJobActive?: boolean;
  /** Since this hook last issued a read, or `null` when it never has. */
  sinceLastReadMs: number | null;
}): boolean {
  if (!input.visible) return false;
  if (!input.watching) return false;
  if (isJobSettled(input.heldStatus) && !input.isJobActive) return false;
  return input.sinceLastReadMs === null || input.sinceLastReadMs >= POLL_FAST_MS;
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
  /**
   * Which job the watchdog stop was measured against.
   *
   * A stop also switches polling off (`shouldPoll` below), so nothing in this
   * hook could ever notice the *next* build: the chat sat behind "Previous
   * generation stopped" with a locked input while a healthy repair job — one
   * started from the preview's own Fix this button — ran to completion unseen.
   * A verdict about one job must not outlive it.
   */
  const stoppedJobIdRef = useRef<string | null>(null);
  /**
   * The row this hook is holding, and the project it was read for. `job` state
   * cannot answer that second half — it survives a project switch until the
   * first poll of the new one returns.
   */
  const heldJobRef = useRef<{ projectId: string | null; status: string | null }>({
    projectId: null,
    status: null,
  });
  /** The project whose opening read has already been spent — see both effects below. */
  const openingReadRef = useRef<string | null>(null);
  /**
   * When this hook last *issued* a read, not when one last returned: the floor under the
   * focus catch-up has to count a request that is still in flight, or a burst of focus
   * events would each start one before the first came back.
   */
  const lastReadAtRef = useRef<number | null>(null);
  /** What the poll effect saw the last time it ran, so a re-run is distinguishable from a fresh arm. */
  const armedRef = useRef<{ projectId: string | null; polling: boolean }>({
    projectId: null,
    polling: false,
  });
  /**
   * The row in hand at the moment the stream in this tab began — the only thing that tells a
   * row which predates that stream from the stream's own outcome. See `streamOutrunsHeldRow`.
   *
   * State adjusted during the render that first sees the flag change, not an effect, because
   * `shouldPoll` is computed here: an effect would record it a render too late and the watch
   * would refuse to arm on the render a build starts on. Read from `job` rather than
   * `heldJobRef` so the snapshot and the comparison against it are the same value; a ref must
   * not be read during render anyway.
   */
  const [streamBegan, setStreamBegan] = useState<{ active: boolean; rowId: string | null }>(() => ({
    active: Boolean(isJobActive),
    rowId: null,
  }));
  if (streamBegan.active !== Boolean(isJobActive)) {
    setStreamBegan({ active: Boolean(isJobActive), rowId: isJobActive ? (job?.id ?? null) : null });
  }

  const refresh = useCallback(async () => {
    if (!projectId) return null;
    lastReadAtRef.current = Date.now();
    let response: Response;
    try {
      response = await fetch(`/api/projects/${projectId}/job`);
    } catch (error) {
      // An offline browser rejected here with a TypeError nothing caught, so the
      // whole poll loop died on the first failed tick: the workspace kept its
      // spinner and never watched the build again, even after the connection came
      // back (F-446). The caller reschedules; the banner says why.
      if (isNetworkFailure(error)) {
        reportNetworkFailure();
        return null;
      }
      throw error;
    }
    reportNetworkSuccess();
    if (!response.ok) return null;
    const data = (await response.json()) as { job?: PublicGenerationJob | null };
    const next = data.job ?? null;
    setJob(next);
    heldJobRef.current = { projectId, status: next?.status ?? null };
    return next;
  }, [projectId]);

  /**
   * `isJobActive`, minus the part of it the row in hand already answers. Every guard below
   * takes this rather than the raw flag: a runtime left on `generating` after its build
   * SUCCEEDED is what kept a finished workspace reading the job endpoint on every focus.
   */
  const streamAhead = streamOutrunsHeldRow({
    isJobActive,
    jobId: job?.id,
    jobStatus: job?.status,
    rowIdWhenStreamBegan: streamBegan.rowId,
  });

  const shouldPoll = jobWatchIsLive({
    projectId,
    clientStop,
    phase,
    jobStatus: job?.status,
    isJobActive: streamAhead,
  });

  useEffect(() => {
    if (!projectId) return;
    // The poll effect below opens with its own `tick()`, so a mount that armed the
    // watch fired two identical GETs at once — this one and that one. That effect
    // claims the opening read when it runs, leaving this as the read for a project
    // nothing is watching. The ref is what keeps the watch ending (shouldPoll going
    // false again) from spending a third.
    if (shouldPoll) return;
    if (openingReadRef.current === projectId) return;
    openingReadRef.current = projectId;
    void refresh();
  }, [projectId, refresh, shouldPoll]);

  // New work clears the old verdict, which also turns polling back on.
  useEffect(() => {
    const stale = watchdogStopIsStale({
      stop: clientStop,
      stoppedJobId: stoppedJobIdRef.current,
      jobId: job?.id,
      isJobActive,
    });
    if (!stale) return;
    stoppedJobIdRef.current = null;
    setClientStop(null);
  }, [clientStop, isJobActive, job?.id]);

  useEffect(() => {
    const previous = armedRef.current;
    armedRef.current = { projectId, polling: Boolean(shouldPoll) };
    if (!shouldPoll) return;
    // A watch, not the mount: the cleanup below clears this again so the next
    // build is timed from its own beginning. `act` may have stamped it already.
    startedAtRef.current ??= Date.now();
    openingReadRef.current = projectId;
    // Already armed for this project on the previous run, so this is a re-run —
    // an identity change in a dependency, `isJobActive` falling away — and not a
    // watch opening on work we have not read yet.
    const alreadyArmed = previous.polling && previous.projectId === projectId;
    let timer: number | null = null;
    let cancelled = false;

    const tick = async () => {
      const next = await refresh();
      if (cancelled) return;
      // Settled first: the job's own end state is the answer, and asking the
      // watchdog about a job that already finished only invents a failure —
      // its heartbeat stopped when it ended, so it is stale by definition.
      if (isJobSettled(next?.status)) {
        stoppedJobIdRef.current = null;
        setClientStop(null);
        return;
      }
      const startedAtMs = watchStartedAtMs(next, startedAtRef.current ?? Date.now());
      // Offline, nothing here knows anything about the job: `refresh` returned
      // null because the request never left. Handing the watchdog a missing
      // heartbeat would make it call a healthy build dead, so the tick just
      // reschedules and the offline banner carries the explanation (F-446).
      if (connectionState() === 'offline') {
        timer = window.setTimeout(
          () => {
            void tick();
          },
          nextPollIntervalMs(Date.now() - startedAtMs),
        );
        return;
      }
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
        stoppedJobIdRef.current = next?.id ?? null;
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

    if (
      shouldFetchOnWatchStart({
        projectId,
        heldProjectId: heldJobRef.current.projectId,
        heldStatus: heldJobRef.current.status,
        isJobActive: streamAhead,
        alreadyArmed,
      })
    ) {
      void tick();
    }
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      // Stop measuring: the next watch is a different build. Leaving this set is
      // what turned a long-open workspace into an instant "timeout".
      startedAtRef.current = null;
    };
  }, [projectId, refresh, shouldPoll, streamAhead]);

  /**
   * Catch up the moment the tab is looked at again — but only while there is something to
   * catch up on.
   *
   * Browsers throttle timers in background tabs to a minute or more, so a build watched from
   * another tab polls far too slowly to see it finish: the person comes back to a spinner, or
   * to a stale-heartbeat verdict on work that succeeded while they were away. Waiting is the
   * normal thing to do while a site builds, so returning has to re-read the truth. A project
   * that has finished building has no truth left to re-read, and this pair of listeners is the
   * only thing in this hook that outlives the watch — see `shouldCatchUpOnVisible` for the
   * 11-requests-in-40-seconds that came out of that.
   */
  useEffect(() => {
    if (!projectId) return;
    const onVisible = () => {
      const held = heldJobRef.current;
      const lastRead = lastReadAtRef.current;
      if (
        !shouldCatchUpOnVisible({
          visible: document.visibilityState === 'visible',
          watching: shouldPoll,
          // A row read for the project we just left says nothing about this one.
          heldStatus: held.projectId === projectId ? held.status : null,
          isJobActive: streamAhead,
          sinceLastReadMs: lastRead === null ? null : Date.now() - lastRead,
        })
      ) {
        return;
      }
      void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [projectId, refresh, shouldPoll, streamAhead]);

  /**
   * A settled row belongs to the turn that finished, and must not gate the next
   * one. `ProjectWorkspace` computes the chat's "working" state as
   * `sending && (!job || isJobInFlight(job.status))`, so the previous build's
   * SUCCEEDED row silenced every progress signal on the following send: no
   * indicator, no file name, no elapsed clock — the chat looked idle while the
   * server ran QUEUED → RUNNING. A stream in this tab is newer than any row we
   * last polled, so the row is unknown until a poll returns the new one.
   *
   * Masked on `streamAhead`, not the raw flag: once the row *is* the stream's own
   * outcome, hiding it leaves the chat waiting on a turn that has finished.
   */
  const activeJob = streamAhead && isJobSettled(job?.status) ? null : job;

  // A watchdog stop only means "we stopped watching". If the job has since
  // settled, its status decides — a SUCCEEDED build must never show recovery.
  // Read from `activeJob`, not the raw row, and only for kinds chat started:
  // see chatRecoveryVerdict for the two ways that went wrong.
  const recovery = chatRecoveryVerdict({ job: activeJob, clientStop });

  const act = useCallback(
    async (action: 'keep' | 'retry' | 'start-over' | 'cancel', body?: Record<string, unknown>) => {
      if (!projectId) return { ok: false as const, error: 'Project is not ready' };
      // Name the job this panel is showing. The routes used to resolve their own target
      // from the project's newest job, so a click against a panel drawn seconds earlier hit
      // whatever had started since — "start over" cancelled a running publish. When the
      // watchdog opened the panel there may be no job object to name; the server then falls
      // back to the newest chat job only, so a publish still cannot be hit from here.
      //
      // `activeJob`, not the raw row: the row this hook is holding is the *previous* turn's
      // for the second or two between a stream starting in this tab and the first poll that
      // returns the new job. Naming that row makes the server refuse — it is not what is
      // active — so Stop pressed early in a build would have answered "This project has
      // moved on" instead of stopping it. Masked to null, the server resolves the newest
      // chat job, which in that window is the build that just started.
      const jobId = activeJob?.id ?? null;
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
    [activeJob?.id, projectId, refresh],
  );

  return {
    job: activeJob,
    recovery,
    clientStop,
    busy,
    refresh,
    keep: () => act('keep'),
    retry: (idempotencyKey?: string) => act('retry', { idempotencyKey }),
    startOver: () => act('start-over'),
    cancel: () => act('cancel'),
  };
}
