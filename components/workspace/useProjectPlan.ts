'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  approvedBuildPrompt,
  toWorkspacePlan,
  type ProjectPhase,
  type WorkspacePlan,
} from './types';

const POLL_MS = 5000;

/** A job that has stopped, whatever the reason. */
const TERMINAL_JOB_STATUSES: Record<string, true> = {
  SUCCEEDED: true,
  FAILED: true,
  ABANDONED: true,
  CANCELLED: true,
};

/**
 * What one poll may conclude about the project's phase.
 *
 * Nothing here derives a phase. COMPLETE means a finished site — `lastCode` or a
 * checkpoint — and only the server can see either: it settles the row through
 * `resumablePhaseFromEvidence` on every terminal job write. This hook used to promote
 * BUILDING to COMPLETE whenever the latest job was ABANDONED / FAILED / CANCELLED, or
 * whenever `generationStatus` read `ready`, so a first build that failed with zero files
 * showed as a finished project: no plan gate, no plan card, and a preview claiming to
 * have something to show (F-048).
 *
 * `recheck` covers the one honest reason to look again: the project row is read before
 * the job row, and the server writes both when a job settles, so a terminal job seen
 * next to a BUILDING phase means the reading is simply older than the transition.
 */
export function phaseFromPoll(input: {
  serverPhase: ProjectPhase | null;
  jobStatus: string | null | undefined;
  localPhase: ProjectPhase | null;
}): { phase: ProjectPhase | null; recheck: boolean } {
  const phase = input.serverPhase ?? input.localPhase;
  return {
    phase,
    recheck: phase === 'BUILDING' && Boolean(TERMINAL_JOB_STATUSES[input.jobStatus ?? '']),
  };
}

export function useProjectPlan({
  projectId,
  initialPhase,
  initialPlan,
  isJobActive,
  generationStatus,
}: {
  projectId: string | null;
  initialPhase?: ProjectPhase | null;
  initialPlan?: WorkspacePlan | null;
  isJobActive?: boolean;
  generationStatus?: string | null;
}) {
  const [phase, setPhase] = useState<ProjectPhase | null>(initialPhase ?? null);
  const [plan, setPlan] = useState<WorkspacePlan | null>(initialPlan ?? null);
  const [refining, setRefining] = useState(false);
  const [approving, setApproving] = useState(false);
  const [watchPlan, setWatchPlan] = useState(false);
  const approveKeyRef = useRef<string | null>(null);
  // A mirror, so `refresh` does not take `phase` as a dependency: the poll interval is
  // keyed on that callback, and re-creating it on every phase change would restart the
  // timer on each poll. Synced in an effect — a ref must not be written during render.
  const phaseRef = useRef(phase);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    const readPhase = async (): Promise<ProjectPhase | null> => {
      const response = await fetch(`/api/projects/${projectId}`);
      if (!response.ok) return null;
      const data = (await response.json()) as { project?: { phase?: ProjectPhase } };
      return data.project?.phase ?? null;
    };
    try {
      const [serverPhase, planRes, jobRes] = await Promise.all([
        readPhase(),
        fetch(`/api/projects/${projectId}/plan`),
        fetch(`/api/projects/${projectId}/job`),
      ]);
      let jobStatus: string | null = null;
      if (jobRes.ok) {
        const data = (await jobRes.json()) as { job?: { status?: string } | null };
        jobStatus = data.job?.status ?? null;
      }
      const polled = phaseFromPoll({ serverPhase, jobStatus, localPhase: phaseRef.current });
      // The re-read costs one request and only happens on the poll where a job settled.
      const settled = polled.recheck ? ((await readPhase()) ?? polled.phase) : polled.phase;
      if (settled) setPhase(settled);
      if (planRes.ok) {
        const data = (await planRes.json()) as { plan?: unknown };
        setPlan(toWorkspacePlan(data.plan));
      }
    } catch {
      /* keep last known phase/plan */
    }
  }, [projectId]);

  // `generationStatus` reaching 'ready' is the client's own runtime talking, not the
  // server: it used to set COMPLETE here directly. Re-read instead — the terminal PATCH
  // that produced 'ready' is also what makes the server's phase current.
  useEffect(() => {
    if (phase !== 'BUILDING') return;
    if (isJobActive) return;
    if (generationStatus === 'ready') void refresh();
  }, [generationStatus, isJobActive, phase, refresh]);

  useEffect(() => {
    if (phase === 'PLANNING' && watchPlan) setWatchPlan(false);
  }, [phase, watchPlan]);

  useEffect(() => {
    if (!watchPlan) return;
    const timer = window.setTimeout(() => setWatchPlan(false), 20_000);
    return () => window.clearTimeout(timer);
  }, [watchPlan]);

  const shouldPoll =
    Boolean(projectId) && (phase === 'PLANNING' || phase === 'BUILDING' || watchPlan);

  useEffect(() => {
    if (!shouldPoll) return;
    const timer = window.setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, shouldPoll]);

  // Background tabs throttle this interval to a minute or more, so a plan that
  // finished while the person was elsewhere would keep showing "Drafting your
  // plan…" until they reloaded. Re-read as soon as they look back.
  useEffect(() => {
    if (!shouldPoll) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [refresh, shouldPoll]);

  const refine = useCallback(
    async (feedback: string) => {
      if (!projectId) return { ok: false as const, error: 'Project is not ready' };
      setRefining(true);
      try {
        const response = await fetch(`/api/projects/${projectId}/plan/refine`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ feedback }),
        });
        const data = (await response.json().catch(() => null)) as {
          plan?: unknown;
          error?: string;
        } | null;
        if (!response.ok) {
          return { ok: false as const, error: data?.error || 'Could not update the plan' };
        }
        setPlan(toWorkspacePlan(data?.plan));
        setPhase('PLANNING');
        return { ok: true as const };
      } catch {
        return { ok: false as const, error: 'Could not update the plan' };
      } finally {
        setRefining(false);
      }
    },
    [projectId],
  );

  const updatePlan = useCallback(
    async (content: WorkspacePlan['content']) => {
      if (!projectId || !plan) return { ok: false as const, error: 'No plan to edit' };
      try {
        const response = await fetch(`/api/projects/${projectId}/plan`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ planId: plan.id, content }),
        });
        const data = (await response.json().catch(() => null)) as {
          plan?: unknown;
          error?: string;
        } | null;
        if (!response.ok) {
          return { ok: false as const, error: data?.error || 'Could not save the plan' };
        }
        const next = toWorkspacePlan(data?.plan);
        if (!next) return { ok: false as const, error: 'Could not read the saved plan' };
        setPlan(next);
        return { ok: true as const };
      } catch {
        return { ok: false as const, error: 'Could not save the plan' };
      }
    },
    [plan, projectId],
  );

  const approve = useCallback(async () => {
    if (!projectId || approving) return { ok: false as const, error: 'Project is not ready' };
    setApproving(true);
    try {
      if (!approveKeyRef.current) {
        approveKeyRef.current =
          typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : `approve-${Date.now()}`;
      }
      const response = await fetch(`/api/projects/${projectId}/plan/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idempotencyKey: approveKeyRef.current }),
      });
      const data = (await response.json().catch(() => null)) as {
        plan?: unknown;
        error?: string;
      } | null;
      if (!response.ok) {
        return { ok: false as const, error: data?.error || 'Could not approve the plan' };
      }
      const next =
        toWorkspacePlan(data?.plan) ?? (plan ? { ...plan, status: 'APPROVED' as const } : null);
      setPlan(next);
      setPhase('BUILDING');
      // This plan's key has been spent. A follow-up request mints a new
      // PENDING plan on the same mount, and replaying this key would make the
      // approve route answer with the previous plan instead of approving the
      // new one.
      approveKeyRef.current = null;
      return {
        ok: true as const,
        plan: next,
        promptContext: next ? approvedBuildPrompt(next) : '',
      };
    } catch {
      return { ok: false as const, error: 'Could not approve the plan' };
    } finally {
      // Clear on every exit, success included: the success path used to leave
      // this stuck true, and because the component stays mounted through the
      // build, the next plan's "Approve & Build" rendered disabled forever and
      // the guard on entry short-circuited every click until a reload.
      setApproving(false);
    }
  }, [approving, plan, projectId]);

  const watchForPlan = useCallback(() => {
    setWatchPlan(true);
    void refresh();
    window.setTimeout(() => void refresh(), 1200);
    window.setTimeout(() => void refresh(), 3000);
  }, [refresh]);

  return {
    phase,
    plan,
    refining,
    approving,
    refine,
    approve,
    updatePlan,
    refresh,
    watchForPlan,
  };
}
