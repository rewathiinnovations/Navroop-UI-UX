'use client';

import {
  AlertTriangle,
  Bug,
  GitBranch,
  HardDrive,
  ListChecks,
  Plug,
  Server,
  Sparkles,
} from 'lucide-react';
import AdminCard from '@/components/admin/AdminCard';
import AdminPage from '@/components/admin/AdminPage';
import AdminTabs, { type AdminTab } from '@/components/admin/AdminTabs';
import StatTile from '@/components/admin/StatTile';
import StatusBanner from '@/components/admin/StatusBanner';
import { notify, toMessage } from '@/lib/notify';
import StudioButton from '@/components/app/studio/StudioButton';
import { useEffect, useState } from 'react';
import { formatAdminDate, formatAdminDateTime } from '../format-admin-date';

type HealthPayload = {
  release?: {
    sha: string;
    deployedAt: string;
    history: Array<{ sha: string; deployedAt: string }>;
  };
  self?: {
    coolifyAppUuid: string | null;
    gitSha: string;
    instanceId: string;
    environment: string;
  };
  integrations: Array<{
    kind: string;
    status: string;
    lastCheckedAt: string | null;
    lastError: string | null;
  }>;
  failures: {
    last24h: { generations: number; publishes: number; sandboxBoots: number };
    last7d: { generations: number; publishes: number; sandboxBoots: number };
  };
  topErrorCodes: Array<{ code: string; count: number }>;
  sandboxes: { current: number; limit: number };
  orphans?: {
    checkedAt: string | null;
    coolify: number;
    dns: number;
    repos: number;
    deleted: number;
  };
  providers?: Array<{
    id: string;
    provider: string;
    model: string;
    healthy: boolean;
  }>;
  errorTracking?: {
    status: 'Healthy' | 'Degraded' | 'Not reporting';
    lastSuccessfulSendAt: string | null;
    lastConfirmedReceiptAt: string | null;
    quota: { used: number; limit: number; resetsAt: string | null } | null;
    dropped24h: Array<{ reason: string; count: number }>;
    topIssues: Array<{ id: string; title: string; count: number }>;
    dsnProjectId: string | null;
    environment: string;
    releaseSha: string;
    dsnConfigured: boolean;
  };
  systemChecks?: Array<{
    name: string;
    lastRunAt: string | null;
    ok: boolean | null;
    stale: boolean;
    detail: string | null;
  }>;
  dataDir?: {
    state: 'ok' | 'not_checked' | 'unwritable';
    message: string;
    checked: boolean;
    path: string;
    writable: boolean;
    error: string | null;
    volumeId: string | null;
    volumeCreatedAt: string | null;
    volumeAgeSeconds: number | null;
    volumeChanged: boolean;
    previousVolumeId: string | null;
    freeBytes: number | null;
    totalBytes: number | null;
    freeRatio: number | null;
    warnLowSpace: boolean;
    alertLowSpace: boolean;
  };
};

export default function HealthDashboard() {
  const [data, setData] = useState<HealthPayload | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [confirm, setConfirm] = useState('');
  const [rollingBack, setRollingBack] = useState(false);
  const [rollbackMessage, setRollbackMessage] = useState('');
  const [testBusy, setTestBusy] = useState(false);
  const [testMessage, setTestMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const response = await fetch('/api/admin/health');
        if (response.status === 403) {
          window.location.replace('/dashboard');
          return;
        }
        const payload = await response.json();
        if (!response.ok) {
          if (!cancelled) setError(payload.error || 'Could not load health');
          return;
        }
        if (!cancelled) setData(payload);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const cards = data
    ? [
        { label: 'Failed generations (24h)', value: String(data.failures.last24h.generations) },
        { label: 'Failed publishes (24h)', value: String(data.failures.last24h.publishes) },
        { label: 'Failed sandbox boots (24h)', value: String(data.failures.last24h.sandboxBoots) },
        { label: 'Failed generations (7d)', value: String(data.failures.last7d.generations) },
        { label: 'Failed publishes (7d)', value: String(data.failures.last7d.publishes) },
        { label: 'Failed sandbox boots (7d)', value: String(data.failures.last7d.sandboxBoots) },
        {
          label: 'Sandboxes vs plan',
          value: `${data.sandboxes.current} / ${data.sandboxes.limit < 0 ? '∞' : data.sandboxes.limit}`,
        },
        { label: 'Orphan Coolify apps', value: String(data.orphans?.coolify ?? 0) },
        { label: 'Orphan DNS records', value: String(data.orphans?.dns ?? 0) },
        {
          label: 'Orphan deploy repos (report only)',
          value: String(data.orphans?.repos ?? 0),
        },
      ]
    : [];

  const tabs: AdminTab[] = [
    data?.release && {
      id: 'release',
      label: 'Release',
      icon: <GitBranch className="size-13" aria-hidden />,
      panel: (
        <AdminCard>
          <p className="text-[13px] text-[var(--studio-fg)]">
            <span className="font-medium">{data.release.sha}</span>
            {data.release.deployedAt !== '1970-01-01T00:00:00.000Z' ? (
              <span className="text-[var(--studio-muted)]">{` — deployed ${formatAdminDateTime(data.release.deployedAt)}`}</span>
            ) : (
              <span className="text-[var(--studio-muted)]"> — deploy time unknown</span>
            )}
          </p>
          <p className="mt-8 text-[12px] text-[var(--studio-muted)]">
            Rolling back the app does not revert the database. Restore from backup if the schema
            changed.
          </p>
          {(data.release.history || []).length > 0 && (
            <ul className="mt-12 space-y-4 text-[12px] text-[var(--studio-muted)]">
              {data.release.history.slice(0, 10).map((row) => (
                <li key={row.sha}>
                  {row.sha}
                  {` — ${formatAdminDateTime(row.deployedAt)}`}
                </li>
              ))}
            </ul>
          )}
          <label className="mt-16 block text-[13px] text-[var(--studio-fg)]">
            Type <span className="font-medium">roll back</span> to confirm
            <input
              className="mt-6 h-40 w-full rounded-10 border border-[var(--studio-line-strong)] bg-[var(--studio-bg)] px-12 text-[13px] text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              autoComplete="off"
            />
          </label>
          <div className="mt-12">
            <StudioButton
              type="button"
              variant="danger"
              disabled={rollingBack || confirm.trim().toLowerCase() !== 'roll back'}
              onClick={async () => {
                setRollingBack(true);
                setRollbackMessage('');
                const toastId = notify.loading('Requesting rollback…');
                try {
                  const response = await fetch('/api/admin/health/rollback', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ confirmation: confirm }),
                  });
                  const payload = await response.json();
                  if (!response.ok) {
                    notify.settle(toastId, 'error', payload.error || 'Could not roll back');
                    setRollbackMessage(payload.error || 'Could not roll back');
                    return;
                  }
                  const detail = `Rollback requested to ${payload.sha}. ${payload.note || ''}`.trim();
                  notify.settle(toastId, 'success', detail);
                  setRollbackMessage(detail);
                } catch (cause) {
                  notify.settle(toastId, 'error', toMessage(cause, 'Could not roll back'));
                } finally {
                  setRollingBack(false);
                }
              }}
            >
              {rollingBack ? 'Rolling back…' : 'Roll back to previous release'}
            </StudioButton>
          </div>
          {rollbackMessage ? (
            <p className="mt-8 text-[13px] text-[var(--studio-muted)]" role="status">
              {rollbackMessage}
            </p>
          ) : null}
        </AdminCard>
      ),
    },
    data?.self && {
      id: 'instance',
      label: 'Instance',
      icon: <Server className="size-13" aria-hidden />,
      panel: (
        <AdminCard>
          <p className="text-[13px] text-[var(--studio-fg)]">
            Coolify application{' '}
            {data.self.coolifyAppUuid ? (
              <span className="font-medium">{data.self.coolifyAppUuid}</span>
            ) : (
              <span className="font-medium">not configured</span>
            )}
          </p>
          {!data.self.coolifyAppUuid && (
            <p className="mt-6 text-[12px] text-[var(--studio-muted)]">
              COOLIFY_APP_UUID is not set, so Navroop cannot identify its own Coolify application.
              Rollback and the Sentry restart will refuse to run until it is set in the deployment
              environment.
            </p>
          )}
          <p className="mt-8 text-[12px] text-[var(--studio-muted)]">
            {`${data.self.environment} · commit ${data.self.gitSha} · instance ${data.self.instanceId}`}
          </p>
        </AdminCard>
      ),
    },
    data?.dataDir && {
      id: 'volume',
      label: 'Volume',
      icon: <HardDrive className="size-13" aria-hidden />,
      panel: (
        <AdminCard>
          <p
            className={
              data.dataDir.state === 'unwritable' || data.dataDir.warnLowSpace
                ? 'text-[13px] text-[var(--studio-danger)]'
                : 'text-[13px] text-[var(--studio-muted)]'
            }
          >
            {data.dataDir.state === 'unwritable'
              ? 'Not writable'
              : data.dataDir.state === 'not_checked'
                ? 'Not checked yet'
                : data.dataDir.alertLowSpace
                  ? 'Writable — free space is under 10%'
                  : data.dataDir.warnLowSpace
                    ? 'Writable — free space is under 20%'
                    : 'Writable'}
          </p>
          {data.dataDir.state === 'not_checked' ? (
            <p className="mt-4 text-[13px] text-[var(--studio-muted)]">
              The boot probe has not run in this process, so writability is unknown. This is not a
              failure.
            </p>
          ) : null}
          <p className="mt-10 text-[13px] text-[var(--studio-fg)]">
            Path: <span className="font-medium">{data.dataDir.path}</span>
          </p>
          <p className="mt-4 text-[13px] text-[var(--studio-fg)]">
            Volume id: <span className="font-medium">{data.dataDir.volumeId || 'none'}</span>
            {data.dataDir.volumeAgeSeconds != null ? (
              <span className="text-[var(--studio-muted)]">
                {` — age ${Math.floor(data.dataDir.volumeAgeSeconds / 86400)}d`}
              </span>
            ) : null}
          </p>
          {data.dataDir.volumeChanged ? (
            <p className="mt-4 text-[13px] text-[var(--studio-danger)]">
              Volume id changed
              {data.dataDir.previousVolumeId ? ` (was ${data.dataDir.previousVolumeId})` : ''}. This
              is a fresh volume or a lost mount. Reconstructible state is rebuilt from the database
              or object storage.
            </p>
          ) : null}
          <p className="mt-4 text-[13px] text-[var(--studio-fg)]">
            Free space:{' '}
            <span className="font-medium">
              {data.dataDir.freeBytes != null && data.dataDir.totalBytes != null
                ? `${Math.round((data.dataDir.freeBytes / (1024 * 1024 * 1024)) * 10) / 10} GB of ${Math.round((data.dataDir.totalBytes / (1024 * 1024 * 1024)) * 10) / 10} GB`
                : 'unknown'}
            </span>
            {data.dataDir.freeRatio != null
              ? ` (${Math.round(data.dataDir.freeRatio * 100)}% free)`
              : ''}
          </p>
          {data.dataDir.error ? (
            <p className="mt-8 text-[13px] text-[var(--studio-danger)]" role="alert">
              {data.dataDir.error}
            </p>
          ) : null}
          <p className="mt-10 text-[12px] text-[var(--studio-muted)]">
            The volume is a cache and bootstrap shortcut. If it is deleted, the next boot rebuilds
            it from Postgres or object storage. It is not included in the database backup.
          </p>
        </AdminCard>
      ),
    },
    data?.errorTracking && {
      id: 'error-tracking',
      label: 'Error tracking',
      icon: <Bug className="size-13" aria-hidden />,
      panel: (
        <AdminCard>
          <p
            className={
              data.errorTracking.status === 'Healthy'
                ? 'text-[13px] text-[var(--studio-muted)]'
                : 'text-[13px] text-[var(--studio-danger)]'
            }
          >
            {data.errorTracking.status}
          </p>
          <p className="mt-10 text-[13px] text-[var(--studio-fg)]">
            Last successful send:{' '}
            <span className="font-medium">
              {data.errorTracking.lastSuccessfulSendAt
                ? formatAdminDateTime(data.errorTracking.lastSuccessfulSendAt)
                : 'never'}
            </span>
          </p>
          <p className="mt-4 text-[13px] text-[var(--studio-fg)]">
            Last confirmed Sentry receipt:{' '}
            <span className="font-medium">
              {data.errorTracking.lastConfirmedReceiptAt
                ? formatAdminDateTime(data.errorTracking.lastConfirmedReceiptAt)
                : 'never'}
            </span>
          </p>
          {data.errorTracking.quota ? (
            <div className="mt-14">
              <p className="text-[12px] uppercase tracking-[0.08em] text-[var(--studio-faint)]">
                Quota {data.errorTracking.quota.used} / {data.errorTracking.quota.limit}
                {data.errorTracking.quota.resetsAt
                  ? ` · resets ${formatAdminDate(data.errorTracking.quota.resetsAt)}`
                  : ''}
              </p>
              <div className="mt-6 h-8 overflow-hidden rounded-12 bg-[var(--studio-bg)]">
                <div
                  className="h-full bg-[var(--studio-accent)]"
                  style={{
                    width: `${Math.min(
                      100,
                      data.errorTracking.quota.limit > 0
                        ? (data.errorTracking.quota.used / data.errorTracking.quota.limit) * 100
                        : 0,
                    )}%`,
                  }}
                />
              </div>
            </div>
          ) : (
            <p className="mt-10 text-[13px] text-[var(--studio-muted)]">
              Quota unavailable (Sentry API token not set).
            </p>
          )}
          <div className="mt-14">
            <p className="mb-6 text-[12px] uppercase tracking-[0.08em] text-[var(--studio-faint)]">
              Dropped events (24h)
            </p>
            {(data.errorTracking.dropped24h || []).length === 0 ? (
              <p className="text-[13px] text-[var(--studio-muted)]">No dropped events reported.</p>
            ) : (
              <ul className="space-y-4 text-[13px] text-[var(--studio-fg)]">
                {data.errorTracking.dropped24h.map((row) => (
                  <li key={row.reason}>
                    {row.reason}
                    {` · ${row.count}`}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="mt-14">
            <p className="mb-6 text-[12px] uppercase tracking-[0.08em] text-[var(--studio-faint)]">
              Top issues by volume
            </p>
            {(data.errorTracking.topIssues || []).length === 0 ? (
              <p className="text-[13px] text-[var(--studio-muted)]">No issues returned.</p>
            ) : (
              <ul className="space-y-4 text-[13px] text-[var(--studio-fg)]">
                {data.errorTracking.topIssues.map((row) => (
                  <li key={row.id || row.title}>
                    <span className="font-medium">{row.title}</span>
                    {` · ${row.count}`}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="mt-14 text-[12px] text-[var(--studio-muted)]">
            DSN project {data.errorTracking.dsnProjectId || '—'}
            {` · ${data.errorTracking.environment}`}
            {` · ${data.errorTracking.releaseSha}`}
          </p>
          <div className="mt-14">
            <StudioButton
              type="button"
              variant="ghost"
              disabled={testBusy}
              onClick={async () => {
                setTestBusy(true);
                setTestMessage('');
                // The route waits up to 60s for Sentry to acknowledge, so the
                // pending toast is what tells the admin it is still working.
                const toastId = notify.loading('Sending a test event to Sentry…');
                try {
                  const response = await fetch('/api/admin/health/sentry-test', { method: 'POST' });
                  const payload = await response.json();
                  if (!response.ok) {
                    notify.settle(toastId, 'error', payload.error || 'Could not send test event');
                    setTestMessage(payload.error || 'Could not send test event');
                    return;
                  }
                  const detail = payload.received
                    ? 'Test event received by Sentry.'
                    : 'Test event was sent but not received within 60 seconds.';
                  notify.settle(toastId, payload.received ? 'success' : 'warning', detail);
                  setTestMessage(detail);
                } catch (cause) {
                  notify.settle(toastId, 'error', toMessage(cause, 'Could not send test event'));
                } finally {
                  setTestBusy(false);
                }
              }}
            >
              {testBusy ? 'Sending…' : 'Send test event'}
            </StudioButton>
          </div>
          {testMessage ? (
            <p className="mt-8 text-[13px] text-[var(--studio-muted)]" role="status">
              {testMessage}
            </p>
          ) : null}
        </AdminCard>
      ),
    },
    {
      id: 'integrations',
      label: 'Integrations',
      icon: <Plug className="size-13" aria-hidden />,
      panel: (
        <AdminCard>
          <ul className="space-y-8">
            {(data?.integrations || []).map((row) => (
              <li key={row.kind} className="text-[13px] text-[var(--studio-fg)]">
                <span className="font-medium">{row.kind}</span>
                {` · ${row.status}`}
                {row.lastCheckedAt ? (
                  <span className="text-[var(--studio-muted)]">
                    {` — checked ${formatAdminDateTime(row.lastCheckedAt)}`}
                  </span>
                ) : null}
                {row.lastError ? (
                  <span className="text-[var(--studio-danger)]">{` — ${row.lastError}`}</span>
                ) : null}
              </li>
            ))}
            {!loading && (data?.integrations || []).length === 0 && (
              <li className="text-[13px] text-[var(--studio-muted)]">No integration rows found.</li>
            )}
          </ul>
        </AdminCard>
      ),
    },
    {
      id: 'providers',
      label: 'AI providers',
      icon: <Sparkles className="size-13" aria-hidden />,
      panel: (
        <AdminCard>
          <ul className="space-y-8">
            {(data?.providers || []).map((row) => (
              <li key={row.id} className="text-[13px] text-[var(--studio-fg)]">
                <span className="font-medium">{row.provider}</span>
                {` · ${row.model}`}
                <span
                  className={
                    row.healthy ? 'text-[var(--studio-muted)]' : 'text-[var(--studio-danger)]'
                  }
                >
                  {row.healthy ? ' — healthy' : ' — unhealthy'}
                </span>
              </li>
            ))}
            {!loading && (data?.providers || []).length === 0 && (
              <li className="text-[13px] text-[var(--studio-muted)]">No providers configured.</li>
            )}
          </ul>
        </AdminCard>
      ),
    },
    {
      id: 'checks',
      label: 'System checks',
      icon: <ListChecks className="size-13" aria-hidden />,
      panel: (
        <AdminCard>
          <ul className="space-y-8">
            {(data?.systemChecks || []).map((row) => (
              <li
                key={row.name}
                className={
                  row.stale || row.ok === false
                    ? 'text-[13px] text-[var(--studio-danger)]'
                    : 'text-[13px] text-[var(--studio-fg)]'
                }
              >
                <span className="font-medium">{row.name}</span>
                {row.lastRunAt
                  ? ` — last run ${formatAdminDateTime(row.lastRunAt)}`
                  : ' — never run'}
                {row.ok === false ? ' — failed' : row.ok === true ? ' — ok' : ''}
                {row.stale ? ' — stale' : ''}
                {row.detail ? ` — ${row.detail}` : ''}
              </li>
            ))}
            {!loading && (data?.systemChecks || []).length === 0 && (
              <li className="text-[13px] text-[var(--studio-muted)]">
                No system checks recorded yet.
              </li>
            )}
          </ul>
        </AdminCard>
      ),
    },
    {
      id: 'errors',
      label: 'Top errors',
      icon: <AlertTriangle className="size-13" aria-hidden />,
      panel: (
        <AdminCard>
          {(data?.topErrorCodes || []).length === 0 ? (
            <p className="text-[13px] text-[var(--studio-muted)]">
              No recurring errors in the last 7 days.
            </p>
          ) : (
            <ul className="space-y-8">
              {data!.topErrorCodes.map((row) => (
                <li key={row.code} className="text-[13px] text-[var(--studio-fg)]">
                  <span className="font-medium">{row.code}</span>
                  {` · ${row.count}`}
                </li>
              ))}
            </ul>
          )}
        </AdminCard>
      ),
    },
  ].filter(Boolean) as AdminTab[];

  return (
    <AdminPage
      icon="health"
      title="Health"
      description="Whether this installation is running correctly: release, storage, error tracking, and provider checks."
      width="wide"
    >
      {error && <StatusBanner tone="error">{error}</StatusBanner>}

      <div className="grid grid-cols-1 gap-12 sm:grid-cols-2 xl:grid-cols-5">
        {(loading && !data
          ? Array.from({ length: 10 }, (_, i) => ({ label: '…', value: '—' }))
          : cards
        ).map((card, index) => (
          <StatTile
            key={`${card.label}-${index}`}
            icon={<AlertTriangle className="size-15" aria-hidden />}
            value={card.value}
            label={card.label}
            tone={
              card.value !== '0' && card.value !== '—' && card.value !== '…' ? 'warning' : 'default'
            }
          />
        ))}
      </div>

      <AdminTabs tabs={tabs} />
    </AdminPage>
  );
}
