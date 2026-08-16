'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  approvedBuildPrompt,
  toWorkspacePlan,
  type ProjectPhase,
  type WorkspacePlan,
} from './types';

const POLL_MS = 5000;

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

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      const [projectRes, planRes] = await Promise.all([
        fetch(`/api/projects/${projectId}`),
        fetch(`/api/projects/${projectId}/plan`),
      ]);
      if (projectRes.ok) {
        const data = (await projectRes.json()) as { project?: { phase?: ProjectPhase } };
        if (data.project?.phase) setPhase(data.project.phase);
      }
      if (planRes.ok) {
        const data = (await planRes.json()) as { plan?: unknown };
        setPlan(toWorkspacePlan(data.plan));
      }
    } catch {
      /* keep last known phase/plan */
    }
  }, [projectId]);

  useEffect(() => {
    if (phase !== 'BUILDING') return;
    if (isJobActive) return;
    if (generationStatus === 'ready') setPhase('COMPLETE');
  }, [generationStatus, isJobActive, phase]);

  useEffect(() => {
    if (phase === 'PLANNING' && watchPlan) setWatchPlan(false);
  }, [phase, watchPlan]);

  useEffect(() => {
    if (!watchPlan) return;
    const timer = window.setTimeout(() => setWatchPlan(false), 20_000);
    return () => window.clearTimeout(timer);
  }, [watchPlan]);

  const shouldPoll = Boolean(projectId) && (phase === 'PLANNING' || phase === 'BUILDING' || watchPlan);

  useEffect(() => {
    if (!shouldPoll) return;
    const timer = window.setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => window.clearInterval(timer);
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
        const data = (await response.json().catch(() => null)) as { plan?: unknown; error?: string } | null;
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

  const approve = useCallback(async () => {
    if (!projectId || approving) return { ok: false as const, error: 'Project is not ready' };
    setApproving(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/plan/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = (await response.json().catch(() => null)) as { plan?: unknown; error?: string } | null;
      if (!response.ok) {
        setApproving(false);
        return { ok: false as const, error: data?.error || 'Could not approve the plan' };
      }
      const next = toWorkspacePlan(data?.plan) ?? (plan ? { ...plan, status: 'APPROVED' as const } : null);
      setPlan(next);
      setPhase('BUILDING');
      return {
        ok: true as const,
        plan: next,
        promptContext: next ? approvedBuildPrompt(next) : '',
      };
    } catch {
      setApproving(false);
      return { ok: false as const, error: 'Could not approve the plan' };
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
    refresh,
    watchForPlan,
  };
}
