'use client';

import AdminPage from '@/components/admin/AdminPage';
import ConfirmAction from '@/components/admin/ConfirmAction';
import { useEffect, useState } from 'react';
import StudioButton from '@/components/app/studio/StudioButton';
import { jobAdminFailureLine } from '@/lib/jobs/admin-display';
import { sandboxChoiceLines } from '@/lib/jobs/sandbox-choice';
import type { JobResourceIds } from '@/lib/jobs/types';

type PublicJob = {
  id: string;
  projectId: string;
  kind: string;
  status: string;
  ownerInstance: string | null;
  lastStep: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  createdAt: string;
  ageMs?: number;
  resourceIds?: JobResourceIds | null;
};

type JobsPayload = {
  active: PublicJob[];
  failedByErrorCode: Record<string, PublicJob[]>;
  abandonmentsPerDay: Array<{ day: string; count: number }>;
};

function formatAge(ageMs: number) {
  const minutes = Math.max(0, Math.round(ageMs / 60_000));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
}

export default function JobsAdmin() {
  const [data, setData] = useState<JobsPayload | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/admin/jobs');
      if (response.status === 403) {
        window.location.replace('/dashboard');
        return;
      }
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error?.message || payload.error || 'Could not load jobs');
        return;
      }
      setData(payload);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const abandon = async (id: string) => {
    setBusy(id);
    try {
      const response = await fetch(`/api/admin/jobs/${id}/abandon`, { method: 'POST' });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError(payload.error?.message || payload.error || 'Could not abandon job');
        return;
      }
      await load();
    } finally {
      setBusy(null);
    }
  };

  return (
    <AdminPage
      title="Jobs"
      description="Generation work in progress, and anything that stalled or failed."
      width="wide"
    >
      <p className="mt-6 text-[13px] text-[var(--studio-muted)]">
        Active generation jobs and recent abandonments. Members cannot open this page.
      </p>
      {error ? <p className="mt-12 text-[13px] text-red-600">{error}</p> : null}
      {loading ? <p className="mt-16 text-[13px] text-[var(--studio-muted)]">Loading…</p> : null}

      {data ? (
        <>
          <h2 className="mt-24 text-[16px] font-medium text-[var(--studio-fg)]">Active</h2>
          {data.active.length === 0 ? (
            <p className="mt-8 text-[13px] text-[var(--studio-faint)]">No active jobs</p>
          ) : (
            <div className="mt-10 overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="text-[var(--studio-faint)]">
                    <th className="py-6 pr-12">Project</th>
                    <th className="py-6 pr-12">Kind</th>
                    <th className="py-6 pr-12">Age</th>
                    <th className="py-6 pr-12">Instance</th>
                    <th className="py-6 pr-12">Last step</th>
                    <th className="py-6">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {data.active.map((job) => (
                    <tr key={job.id} className="border-t border-[var(--studio-line)]">
                      <td className="py-8 pr-12 font-mono text-[12px]">{job.projectId}</td>
                      <td className="py-8 pr-12">{job.kind}</td>
                      <td className="py-8 pr-12">{formatAge(job.ageMs ?? 0)}</td>
                      <td className="py-8 pr-12 font-mono text-[12px]">
                        {job.ownerInstance || '—'}
                      </td>
                      <td className="py-8 pr-12">
                        <div>{job.lastStep || '—'}</div>
                        {sandboxChoiceLines(job.resourceIds).map((line) => (
                          <div key={line} className="mt-4 text-[12px] text-[var(--studio-muted)]">
                            {line}
                          </div>
                        ))}
                      </td>
                      <td className="py-8">
                        <ConfirmAction
                          label="Abandon"
                          title="Abandon this job?"
                          body="The work in progress is discarded and the job is marked abandoned. Anyone waiting on it sees it stop. This cannot be undone."
                          confirmLabel="Abandon"
                          busyLabel="Abandoning…"
                          disabled={busy === job.id}
                          onConfirm={() => abandon(job.id)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h2 className="mt-28 text-[16px] font-medium text-[var(--studio-fg)]">
            Abandoned and failed (7 days)
          </h2>
          {Object.keys(data.failedByErrorCode).length === 0 ? (
            <p className="mt-8 text-[13px] text-[var(--studio-faint)]">None in the last 7 days</p>
          ) : (
            Object.entries(data.failedByErrorCode).map(([code, jobs]) => (
              <div key={code} className="mt-14">
                <p className="text-[13px] font-medium text-[var(--studio-fg)]">
                  {code} ({jobs.length})
                </p>
                <ul className="mt-6 space-y-4 text-[12px] text-[var(--studio-muted)]">
                  {jobs.map((job) => {
                    const choice = sandboxChoiceLines(job.resourceIds);
                    return (
                      <li key={job.id}>
                        <span className="font-mono">
                          {job.projectId} · {job.kind} · {jobAdminFailureLine(job)}
                        </span>
                        {choice.length > 0 ? (
                          <ul className="mt-4 space-y-2 font-sans text-[12px]">
                            {choice.map((line) => (
                              <li key={line}>{line}</li>
                            ))}
                          </ul>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}

          <h2 className="mt-28 text-[16px] font-medium text-[var(--studio-fg)]">
            Abandonments per day
          </h2>
          {data.abandonmentsPerDay.length === 0 ? (
            <p className="mt-8 text-[13px] text-[var(--studio-faint)]">No abandonments</p>
          ) : (
            <ul className="mt-8 space-y-4 text-[13px] text-[var(--studio-muted)]">
              {data.abandonmentsPerDay.map((row) => (
                <li key={row.day}>
                  {row.day.slice(0, 10)} — {row.count}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </AdminPage>
  );
}
