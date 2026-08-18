'use client';

import { useEffect, useState } from 'react';
import StudioShell from '@/components/app/studio/StudioShell';
import StudioButton from '@/components/app/studio/StudioButton';
import PageTabs from '@/components/app/studio/PageTabs';
import { adminTabs } from '../plans/PlansAdmin';
import { BACK_UP_NOW_LABEL } from '@/lib/backup/copy';
import { formatAdminDateTime } from '../format-admin-date';

type BackupAdminPayload = {
  lastSuccess: {
    id: string;
    objectKey: string | null;
    sizeBytes: string | null;
    startedAt: string;
    ageMs: number;
  } | null;
  stale: boolean;
  staleBanner: string | null;
  running: { id: string; startedAt: string } | null;
  runs: Array<{
    id: string;
    kind: string;
    status: string;
    objectKey: string | null;
    sizeBytes: string | null;
    durationMs: number | null;
    detail: string | null;
    startedAt: string;
    finishedAt: string | null;
  }>;
  encryptionFingerprint: string | null;
  restoreOverdue: boolean;
  restoreNotice: string | null;
  restoreCommand: string;
  recoverySummary: string;
  alert: { at: string; kind: string; message: string } | null;
};

function formatAge(ageMs: number) {
  const hours = Math.floor(ageMs / 3_600_000);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function BackupsAdmin({ initial }: { initial: BackupAdminPayload }) {
  const [data, setData] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const response = await fetch('/api/admin/backups');
    if (response.status === 403) {
      window.location.replace('/dashboard');
      return;
    }
    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error || 'Could not load backups');
      return;
    }
    setData(payload);
  };

  useEffect(() => {
    if (!data.running && !busy) return;
    const timer = window.setInterval(() => {
      void refresh();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [data.running, busy]);

  const runNow = async () => {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/admin/backups/run', { method: 'POST' });
      const payload = await response.json();
      if (!response.ok) setError(payload.error || 'Backup failed');
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <StudioShell variant="workspace">
      <main className="mx-auto max-w-[1100px] px-20 py-40">
        <h1 className="text-[32px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">Admin</h1>
        <PageTabs items={adminTabs('backups')} />

        {data.staleBanner && (
          <div
            className="mb-16 rounded-12 border border-[var(--studio-danger)]/30 bg-[var(--studio-surface)] p-16"
            role="alert"
          >
            <p className="text-[14px] font-medium text-[var(--studio-danger)]">{data.staleBanner}</p>
          </div>
        )}

        {data.restoreNotice && (
          <div className="mb-16 rounded-12 border border-[var(--studio-danger)]/30 bg-[var(--studio-surface)] p-16">
            <p className="text-[14px] font-medium text-[var(--studio-danger)]">{data.restoreNotice}</p>
            <p className="mt-8 font-mono text-[12px] text-[var(--studio-muted)]">{data.restoreCommand}</p>
          </div>
        )}

        {data.alert && !data.staleBanner && (
          <div className="mb-16 rounded-12 border border-[var(--studio-danger)]/30 bg-[var(--studio-surface)] p-16">
            <p className="text-[14px] font-medium text-[var(--studio-danger)]">{data.alert.message}</p>
          </div>
        )}

        {error && (
          <p className="mb-16 text-[13px] text-[var(--studio-danger)]" role="alert">
            {error}
          </p>
        )}

        <div className="mb-24 grid grid-cols-1 gap-12 sm:grid-cols-3">
          <div className="rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] px-16 py-18">
            <p className="text-[12px] uppercase tracking-[0.08em] text-[var(--studio-faint)]">Last DB backup</p>
            <p className="mt-8 text-[28px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">
              {data.lastSuccess ? formatAge(data.lastSuccess.ageMs) : 'Never'}
            </p>
          </div>
          <div className="rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] px-16 py-18">
            <p className="text-[12px] uppercase tracking-[0.08em] text-[var(--studio-faint)]">Encryption key</p>
            <p className="mt-8 text-[28px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">
              {data.encryptionFingerprint || '—'}
            </p>
          </div>
          <div className="rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] px-16 py-18">
            <p className="text-[12px] uppercase tracking-[0.08em] text-[var(--studio-faint)]">Status</p>
            <p className="mt-8 text-[28px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">
              {data.running || busy ? 'Running' : data.stale ? 'Stale' : 'OK'}
            </p>
          </div>
        </div>

        <div className="mb-24 flex items-center gap-12">
          <StudioButton type="button" onClick={() => void runNow()} disabled={busy || Boolean(data.running)}>
            {busy || data.running ? 'Backing up…' : BACK_UP_NOW_LABEL}
          </StudioButton>
          {(busy || data.running) && (
            <p className="text-[13px] text-[var(--studio-muted)]">Backup in progress. This page refreshes automatically.</p>
          )}
        </div>

        <section className="mb-32">
          <h2 className="mb-12 text-[18px] font-medium text-[var(--studio-fg)]">Recovery</h2>
          <p className="text-[14px] leading-6 text-[var(--studio-muted)]">{data.recoverySummary}</p>
          <p className="mt-12 font-mono text-[12px] text-[var(--studio-fg)]">{data.restoreCommand}</p>
        </section>

        <section>
          <h2 className="mb-12 text-[18px] font-medium text-[var(--studio-fg)]">Recent runs</h2>
          <div className="overflow-x-auto rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)]">
            <table className="w-full text-left text-[14px]">
              <thead className="border-b border-[var(--studio-line)] text-[12px] uppercase tracking-[0.08em] text-[var(--studio-faint)]">
                <tr>
                  <th className="px-16 py-12 font-medium">Started</th>
                  <th className="px-16 py-12 font-medium">Kind</th>
                  <th className="px-16 py-12 font-medium">Status</th>
                  <th className="px-16 py-12 font-medium">Size</th>
                  <th className="px-16 py-12 font-medium">Duration</th>
                  <th className="px-16 py-12 font-medium">Object</th>
                </tr>
              </thead>
              <tbody>
                {data.runs.map((row) => (
                  <tr key={row.id} className="border-t border-[var(--studio-line)]">
                    <td className="px-16 py-12 text-[var(--studio-fg)]">
                      {formatAdminDateTime(row.startedAt)}
                    </td>
                    <td className="px-16 py-12 text-[var(--studio-fg)]">{row.kind}</td>
                    <td className="px-16 py-12 text-[var(--studio-fg)]">{row.status}</td>
                    <td className="px-16 py-12 text-[var(--studio-muted)]">{row.sizeBytes ?? '—'}</td>
                    <td className="px-16 py-12 text-[var(--studio-muted)]">
                      {row.durationMs != null ? `${Math.round(row.durationMs / 1000)}s` : '—'}
                    </td>
                    <td className="px-16 py-12 font-mono text-[12px] text-[var(--studio-muted)]">
                      {row.objectKey || row.detail || '—'}
                    </td>
                  </tr>
                ))}
                {data.runs.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-16 py-16 text-[13px] text-[var(--studio-muted)]">
                      No backup runs yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </StudioShell>
  );
}
