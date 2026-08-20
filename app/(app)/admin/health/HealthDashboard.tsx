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
import { handleAdminForbidden } from '@/lib/admin/forbidden';
import { notify, toMessage } from '@/lib/notify';
import StudioButton from '@/components/app/studio/StudioButton';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatAdminDate, formatAdminDateTime } from '../format-admin-date';
import type { getAdminHealth } from '@/lib/health/admin';

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
    last24h: { generations: number; publishes: number };
    last7d: { generations: number; publishes: number };
  };
  topErrorCodes: Array<{ code: string; count: number }>;
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
    /** `null` limit: Sentry reports no per-project rate limit, so there is no ratio. */
    quota: { used: number; limit: number | null; resetsAt: string | null } | null;
    dropped24h: Array<{ reason: string; count: number }>;
    topIssues: Array<{ id: string; title: string; count: number }>;
    dsnProjectId: string | null;
    environment: string;
    releaseSha: string;
    dsnConfigured: boolean;
    /** Separate from `dsnConfigured`: edge coverage comes from a build-time value (F-786). */
    edgeCovered: boolean;
  };
  systemChecks?: Array<{
    name: string;
    lastRunAt: string | null;
    ok: boolean | null;
    stale: boolean;
    detail: string | null;
  }>;
  /**
   * The four migration-only invariants, probed against the connected database
   * (F-352). `null` means the probe could not run — not the same answer as
   * "all four present", and rendered as its own state.
   */
  dbInvariants?: {
    checkedAt: string;
    probes: Array<{
      name: string;
      table: string;
      matters: string;
      present: boolean;
      malformed: boolean;
    }>;
    broken: string[];
  } | null;
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

/**
 * HealthPayload is hand-written, so it can drift from the route that fills it
 * and nothing complains: when the sandbox subsystem went away the payload lost
 * `sandboxes` and `failures.*.sandboxBoots`, but this type kept declaring them,
 * so `data.sandboxes.current` typechecked and then threw at render, blanking
 * the page. This fails the build instead if a field here has no counterpart on
 * the server. It is types only — `import type` and the aliases below erase, so
 * no server module reaches the client bundle.
 */
type FieldsTheServerDoesNotSend = Exclude<
  keyof HealthPayload,
  keyof Awaited<ReturnType<typeof getAdminHealth>>
>;
type Assert<T extends true> = T;
type _HealthPayloadMatchesServer = Assert<
  [FieldsTheServerDoesNotSend] extends [never] ? true : false
>;

export default function HealthDashboard() {
  const router = useRouter();
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
          handleAdminForbidden(router);
          return;
        }
        const payload = await response.json();
        if (!response.ok) {
          if (!cancelled) setError(payload.error || 'Could not load health');
          return;
        }
        if (!cancelled) setData(payload);
      } catch (cause) {
        if (!cancelled) setError(toMessage(cause, 'Could not load health'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const cards = data
    ? [
        { label: 'Failed generations (24h)', value: String(data.failures.last24h.generations) },
        { label: 'Failed publishes (24h)', value: String(data.failures.last24h.publishes) },
        { label: 'Failed generations (7d)', value: String(data.failures.last7d.generations) },
        { label: 'Failed publishes (7d)', value: String(data.failures.last7d.publishes) },
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
            Rolling back pins the Coolify application to the chosen commit and deploys it; the app
            keeps deploying that commit until a newer one is set. Watch the deployment in Coolify to
            confirm it finishes. The database is not reverted — restore from backup if the schema
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
                const toastId = notify.loading('Requesting the rollback deploy…');
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
                  // The API confirms Coolify accepted the commit pin and started a deploy —
                  // it does not confirm the build finished, so neither does this line.
                  const detail =
                    `Coolify is deploying ${payload.sha}. ${payload.note || ''}`.trim();
                  notify.settle(toastId, 'success', detail);
                  setRollbackMessage(detail);
                } catch (cause) {
                  notify.settle(toastId, 'error', toMessage(cause, 'Could not roll back'));
                } finally {
                  setRollingBack(false);
                }
              }}
            >
              {rollingBack ? 'Requesting…' : 'Roll back to previous release'}
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
                {data.errorTracking.quota.limit === null
                  ? `Accepted ${data.errorTracking.quota.used} · no per-project quota configured in Sentry`
                  : `Quota ${data.errorTracking.quota.used} / ${data.errorTracking.quota.limit}`}
                {data.errorTracking.quota.resetsAt
                  ? ` · resets ${formatAdminDate(data.errorTracking.quota.resetsAt)}`
                  : ''}
              </p>
              {/* No limit means no ratio: a full bar for an unlimited project read as
                  "quota exhausted", which is what mailed every admin daily (F-723). */}
              {data.errorTracking.quota.limit !== null && data.errorTracking.quota.limit > 0 ? (
                <div className="mt-6 h-8 overflow-hidden rounded-12 bg-[var(--studio-bg)]">
                  <div
                    className="h-full bg-[var(--studio-accent)]"
                    style={{
                      width: `${Math.min(
                        100,
                        (data.errorTracking.quota.used / data.errorTracking.quota.limit) * 100,
                      )}%`,
                    }}
                  />
                </div>
              ) : null}
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
          {/* F-786. The edge isolate cannot read the DSN saved in Integrations, so edge and
              middleware errors — the auth gate in proxy.ts among them — are covered only
              when the build argument was passed. Whichever way it went, it is stated. */}
          <div className="mt-14">
            <p className="mb-6 text-[12px] uppercase tracking-[0.08em] text-[var(--studio-faint)]">
              Edge and middleware
            </p>
            <p
              className={
                data.errorTracking.edgeCovered
                  ? 'text-[13px] text-[var(--studio-muted)]'
                  : 'text-[13px] text-[var(--studio-danger)]'
              }
            >
              {data.errorTracking.edgeCovered
                ? 'Edge and middleware errors are captured, from the NEXT_PUBLIC_SENTRY_DSN baked into this image.'
                : 'Edge and middleware errors are not captured. A failure in the auth gate that fronts every /api and /preview-static request is reported nowhere.'}
            </p>
            <p className="mt-6 text-[12px] text-[var(--studio-muted)]">
              The edge runtime cannot read the DSN saved in Integrations. To cover it, pass
              NEXT_PUBLIC_SENTRY_DSN as a build argument and rebuild the image.
            </p>
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
                // The route now waits at most 10s for Sentry to acknowledge, so an
                // unconfirmed send is a normal outcome rather than a timeout.
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
                    : payload.confirmError
                      ? `Test event sent. Sentry could not be asked whether it arrived: ${payload.confirmError}`
                      : 'Test event sent. Sentry had not confirmed it within 10 seconds — reopen Health in a minute to check.';
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
            {!loading && data && (data.integrations || []).length === 0 && (
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
            {!loading && data && (data.providers || []).length === 0 && (
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
            {!loading && data && (data.systemChecks || []).length === 0 && (
              <li className="text-[13px] text-[var(--studio-muted)]">
                No system checks recorded yet.
              </li>
            )}
          </ul>
          <p className="mt-16 text-[12px] font-medium uppercase tracking-wide text-[var(--studio-muted)]">
            Database invariants
          </p>
          {data && data.dbInvariants === null ? (
            <p className="mt-8 text-[13px] text-[var(--studio-danger)]">
              Could not be checked. This is not the same as being present.
            </p>
          ) : (
            <ul className="mt-8 space-y-8">
              {(data?.dbInvariants?.probes || []).map((row) => (
                <li
                  key={row.name}
                  className={
                    row.present && !row.malformed
                      ? 'text-[13px] text-[var(--studio-fg)]'
                      : 'text-[13px] text-[var(--studio-danger)]'
                  }
                >
                  <span className="font-medium">{row.name}</span>
                  {` — ${row.table}`}
                  {row.present
                    ? row.malformed
                      ? ` — present but not the shape the migration created: ${row.matters}`
                      : ' — present'
                    : ` — MISSING: ${row.matters}`}
                </li>
              ))}
              {!loading && data?.dbInvariants && data.dbInvariants.probes.length === 0 && (
                <li className="text-[13px] text-[var(--studio-muted)]">Nothing to check.</li>
              )}
            </ul>
          )}
        </AdminCard>
      ),
    },
    {
      id: 'errors',
      label: 'Top errors',
      icon: <AlertTriangle className="size-13" aria-hidden />,
      panel: (
        <AdminCard>
          {!data ? (
            <p className="text-[13px] text-[var(--studio-muted)]">
              {loading ? 'Loading…' : 'Not loaded.'}
            </p>
          ) : (data.topErrorCodes || []).length === 0 ? (
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
          ? Array.from({ length: 10 }, () => ({ label: '…', value: '—' }))
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
