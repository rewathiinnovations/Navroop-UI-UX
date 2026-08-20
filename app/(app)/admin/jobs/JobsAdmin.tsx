'use client';

import { CalendarClock, Play, XCircle } from 'lucide-react';
import AdminCard from '@/components/admin/AdminCard';
import AdminPage from '@/components/admin/AdminPage';
import { AdminTable, Td, Th, Tr } from '@/components/admin/AdminTable';
import ConfirmAction from '@/components/admin/ConfirmAction';
import StatusBanner from '@/components/admin/StatusBanner';
import { SkeletonTable } from '@/components/admin/AdminSkeleton';
import { useEffect, useState } from 'react';
import { jobAdminFailureLine } from '@/lib/jobs/admin-display';
import { notify, toMessage } from '@/lib/notify';
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
    } catch (cause) {
      setError(toMessage(cause, 'Could not load jobs'));
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
        notify.error(payload.error?.message || payload.error || 'Could not abandon job');
        return;
      }
      notify.success('Job abandoned.');
      await load();
    } catch (cause) {
      notify.error(cause, { fallback: 'Could not abandon job' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <AdminPage
      icon="jobs"
      title="Jobs"
      description="Active generation jobs and recent abandonments. Members cannot open this page."
      width="wide"
    >
      {error && <StatusBanner tone="error">{error}</StatusBanner>}
      {loading && !data && <SkeletonTable rows={4} cols={5} />}

      {data && (
        <>
          <AdminCard icon={<Play className="size-14" aria-hidden />} title="Active">
            <AdminTable
              isEmpty={data.active.length === 0}
              empty="No active jobs."
              head={
                <>
                  <Th>Project</Th>
                  <Th>Kind</Th>
                  <Th>Age</Th>
                  <Th>Instance</Th>
                  <Th>Last step</Th>
                  <Th align="right">Action</Th>
                </>
              }
            >
              {data.active.map((job) => (
                <Tr key={job.id}>
                  <Td mono>{job.projectId}</Td>
                  <Td>{job.kind}</Td>
                  <Td muted>{formatAge(job.ageMs ?? 0)}</Td>
                  <Td mono muted>
                    {job.ownerInstance || '—'}
                  </Td>
                  <Td>
                    <div>{job.lastStep || '—'}</div>
                    {sandboxChoiceLines(job.resourceIds).map((line) => (
                      <div key={line} className="mt-4 text-[12px] text-[var(--studio-muted)]">
                        {line}
                      </div>
                    ))}
                  </Td>
                  <Td align="right">
                    <ConfirmAction
                      label="Abandon"
                      title="Abandon this job?"
                      body="The work in progress is discarded and the job is marked abandoned. Anyone waiting on it sees it stop. This cannot be undone."
                      confirmLabel="Abandon"
                      busyLabel="Abandoning…"
                      disabled={busy === job.id}
                      onConfirm={() => abandon(job.id)}
                    />
                  </Td>
                </Tr>
              ))}
            </AdminTable>
          </AdminCard>

          <AdminCard
            icon={<XCircle className="size-14" aria-hidden />}
            title="Abandoned and failed (7 days)"
          >
            {Object.keys(data.failedByErrorCode).length === 0 ? (
              <p className="text-[13px] text-[var(--studio-faint)]">None in the last 7 days.</p>
            ) : (
              <div className="space-y-16">
                {Object.entries(data.failedByErrorCode).map(([code, jobs]) => (
                  <div key={code}>
                    <p className="text-[13px] font-medium text-[var(--studio-fg)]">
                      {code} <span className="text-[var(--studio-muted)]">({jobs.length})</span>
                    </p>
                    <ul className="mt-6 space-y-6 text-[12px] text-[var(--studio-muted)]">
                      {jobs.map((job) => {
                        const choice = sandboxChoiceLines(job.resourceIds, {
                          omitError: job.errorMessage,
                        });
                        return (
                          <li key={job.id} className="border-l-2 border-[var(--studio-line)] pl-10">
                            <span className="font-mono">
                              {job.projectId} · {job.kind} · {jobAdminFailureLine(job)}
                            </span>
                            {choice.length > 0 && (
                              <ul className="mt-4 space-y-2 font-sans text-[12px]">
                                {choice.map((line) => (
                                  <li key={line}>{line}</li>
                                ))}
                              </ul>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </AdminCard>

          <AdminCard
            icon={<CalendarClock className="size-14" aria-hidden />}
            title="Abandonments per day"
          >
            {data.abandonmentsPerDay.length === 0 ? (
              <p className="text-[13px] text-[var(--studio-faint)]">No abandonments.</p>
            ) : (
              <ul className="space-y-6 text-[13px] text-[var(--studio-muted)]">
                {data.abandonmentsPerDay.map((row) => (
                  <li key={row.day} className="flex items-center justify-between">
                    <span>{row.day.slice(0, 10)}</span>
                    <span className="font-medium text-[var(--studio-fg)]">{row.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </AdminCard>
        </>
      )}
    </AdminPage>
  );
}
