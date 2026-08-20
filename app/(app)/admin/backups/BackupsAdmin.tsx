'use client';

import { Archive, History, KeyRound, LifeBuoy } from 'lucide-react';
import AdminCard from '@/components/admin/AdminCard';
import AdminPage from '@/components/admin/AdminPage';
import { AdminTable, Td, Th, Tr } from '@/components/admin/AdminTable';
import StatTile from '@/components/admin/StatTile';
import StatusBanner from '@/components/admin/StatusBanner';
import { useCallback, useEffect, useRef, useState } from 'react';
import StudioButton from '@/components/app/studio/StudioButton';
import { BACK_UP_NOW_LABEL } from '@/lib/backup/copy';
import { notify, toMessage } from '@/lib/notify';
import { formatAdminDateTime } from '../format-admin-date';
import { connectionState } from '@/lib/net/connection';
import { useRefetchOnReconnect } from '@/hooks/useOnline';
import { BACKUP_POLL_INTERVAL_MS, decidePoll, type PollOutcome } from './poll-policy';

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
  // Consecutive transient poll failures. A ref, not state: the interval must not
  // be torn down and rebuilt on every failed tick.
  const pollFailures = useRef(0);
  const [pollStopped, setPollStopped] = useState(false);

  const settlePoll = useCallback((outcome: PollOutcome, message?: string) => {
    const next = decidePoll({ failures: pollFailures.current, outcome, message });
    pollFailures.current = next.failures;
    setPollStopped(next.stopped);
    setError(next.message);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/admin/backups');
      if (response.status === 403) {
        settlePoll('terminal', 'Your admin access was removed. Reload the page.');
        return;
      }
      // Inside the try: a non-JSON body threw here, and this runs on a timer.
      const payload = await response.json();
      if (!response.ok) {
        settlePoll('transient', payload.error || 'Could not load backups');
        return;
      }
      setData(payload);
      settlePoll('ok');
    } catch (cause) {
      settlePoll('transient', toMessage(cause, 'Could not refresh the backup status'));
    }
  }, [settlePoll]);

  useEffect(() => {
    if (pollStopped) return;
    if (!data.running && !busy) return;
    const timer = window.setInterval(() => {
      // Offline ticks used to spend the transient-failure budget in `decidePoll`,
      // so a short outage stopped the poller for good and the page sat on a stale
      // backup status with a network error above it. The banner already says why
      // nothing is updating (F-446).
      if (connectionState() === 'offline') return;
      void refresh();
    }, BACKUP_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [data.running, busy, pollStopped, refresh]);

  useRefetchOnReconnect(refresh);

  // The route runs the backup synchronously (up to 5 minutes), so this keeps a
  // pending toast on screen and settles it in place with the outcome.
  const runNow = async () => {
    setBusy(true);
    setError('');
    // A manual run is a fresh start for the poller: an earlier give-up must not
    // keep the new backup's progress off the page.
    pollFailures.current = 0;
    setPollStopped(false);
    const toastId = notify.loading('Backing up the database…');
    try {
      const response = await fetch('/api/admin/backups/run', { method: 'POST' });
      const payload = await response.json();
      if (!response.ok) {
        notify.settle(toastId, 'error', payload.error || 'Backup failed');
      } else {
        notify.settle(toastId, 'success', 'Backup completed.');
      }
      await refresh();
    } catch (cause) {
      notify.settle(toastId, 'error', toMessage(cause, 'Backup failed'));
    } finally {
      setBusy(false);
    }
  };

  const status = data.running || busy ? 'Running' : data.stale ? 'Stale' : 'OK';

  return (
    <AdminPage
      icon="backups"
      title="Backups"
      description="When the database was last backed up, and how to restore it."
      width="wide"
      actions={
        <StudioButton
          type="button"
          onClick={() => void runNow()}
          disabled={busy || Boolean(data.running)}
        >
          {busy || data.running ? 'Backing up…' : BACK_UP_NOW_LABEL}
        </StudioButton>
      }
    >
      {data.staleBanner && <StatusBanner tone="error">{data.staleBanner}</StatusBanner>}

      {data.restoreNotice && (
        <StatusBanner tone="error">
          <p>{data.restoreNotice}</p>
          <p className="mt-8 font-mono text-[12px] text-[var(--studio-muted)]">
            {data.restoreCommand}
          </p>
        </StatusBanner>
      )}

      {data.alert && !data.staleBanner && (
        <StatusBanner tone="error">{data.alert.message}</StatusBanner>
      )}
      {error && <StatusBanner tone="error">{error}</StatusBanner>}
      {(busy || data.running) &&
        (pollStopped ? (
          <StatusBanner tone="warning">
            Backup in progress, but this page has stopped refreshing itself. Reload to see where it
            got to.
          </StatusBanner>
        ) : (
          <StatusBanner tone="info">
            Backup in progress. This page refreshes automatically.
          </StatusBanner>
        ))}

      <div className="grid grid-cols-1 gap-12 sm:grid-cols-3">
        <StatTile
          icon={<Archive className="size-16" aria-hidden />}
          value={data.lastSuccess ? formatAge(data.lastSuccess.ageMs) : 'Never'}
          label="Last DB backup"
          tone={data.lastSuccess ? 'default' : 'warning'}
        />
        <StatTile
          icon={<KeyRound className="size-16" aria-hidden />}
          value={data.encryptionFingerprint || '—'}
          label="Encryption key"
        />
        <StatTile
          icon={<Archive className="size-16" aria-hidden />}
          value={status}
          label="Status"
          tone={status === 'Stale' ? 'danger' : status === 'Running' ? 'warning' : 'default'}
        />
      </div>

      <AdminCard icon={<LifeBuoy className="size-14" aria-hidden />} title="Recovery">
        <p className="text-[14px] leading-6 text-[var(--studio-muted)]">{data.recoverySummary}</p>
        <p className="mt-12 font-mono text-[12px] text-[var(--studio-fg)]">{data.restoreCommand}</p>
      </AdminCard>

      <AdminCard icon={<History className="size-14" aria-hidden />} title="Recent runs">
        <AdminTable
          isEmpty={data.runs.length === 0}
          empty="No backup runs yet."
          head={
            <>
              <Th>Started</Th>
              <Th>Kind</Th>
              <Th>Status</Th>
              <Th>Size</Th>
              <Th>Duration</Th>
              <Th>Object</Th>
            </>
          }
        >
          {data.runs.map((row) => (
            <Tr key={row.id}>
              <Td>{formatAdminDateTime(row.startedAt)}</Td>
              <Td>{row.kind}</Td>
              <Td>{row.status}</Td>
              <Td muted>{row.sizeBytes ?? '—'}</Td>
              <Td muted>
                {row.durationMs != null ? `${Math.round(row.durationMs / 1000)}s` : '—'}
              </Td>
              <Td mono muted>
                {row.objectKey || row.detail || '—'}
              </Td>
            </Tr>
          ))}
        </AdminTable>
      </AdminCard>
    </AdminPage>
  );
}
