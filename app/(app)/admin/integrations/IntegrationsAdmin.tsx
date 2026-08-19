'use client';

import { Bug, Cloud, Github, Server, X } from 'lucide-react';
import AdminCard from '@/components/admin/AdminCard';
import AdminPage from '@/components/admin/AdminPage';
import StatusBanner from '@/components/admin/StatusBanner';
import { fetchJson, notify, toMessage } from '@/lib/notify';
import StatusPill, { type StatusTone } from '@/components/admin/StatusPill';
import { FormEvent, useMemo, useState, type ReactNode } from 'react';
import StudioButton from '@/components/app/studio/StudioButton';
import StudioField from '@/components/app/studio/StudioField';
import { resolveSentryMeta } from './sentry-meta';

const KIND_ICON: Record<'GITHUB_DEPLOY' | 'CLOUDFLARE' | 'COOLIFY' | 'SENTRY', typeof Github> = {
  GITHUB_DEPLOY: Github,
  CLOUDFLARE: Cloud,
  COOLIFY: Server,
  SENTRY: Bug,
};

const STATUS_TONE: Record<string, StatusTone> = {
  CONNECTED: 'positive',
  PENDING: 'warning',
  ERROR: 'danger',
  DISCONNECTED: 'neutral',
};

type PublicIntegration = {
  kind: 'GITHUB_DEPLOY' | 'CLOUDFLARE' | 'COOLIFY' | 'SENTRY';
  name: string;
  status: string;
  statusLabel: string;
  detail: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  htmlUrl: string | null;
  org: string | null;
  zoneName: string | null;
  appSlug: string | null;
  orgSlug?: string | null;
  projectSlug?: string | null;
  projectId?: string | null;
  limited?: boolean;
  environment?: string | null;
  tracesSampleRate?: number | null;
  sessionReplay?: boolean;
  performance?: boolean;
  ignoreList?: string[];
  fingerprintLimit?: number;
  fingerprintWindowSec?: number;
  restartRequired?: boolean;
  activeProjectId?: string | null;
  configuredProjectId?: string | null;
  oauthClientId?: string | null;
};

/**
 * What the two check endpoints put in the body. Both answer 200 on failure, so
 * these fields — not the status code — are what the toast reads.
 */
type CheckPayload = {
  error?: string;
  integrations?: PublicIntegration[];
  alert?: { at: string; failures: Array<{ kind: string; error: string }> } | null;
  /** Single-kind check, or the Sentry round-trip (`received`/`message`). */
  result?: { ok?: boolean; error?: string; received?: boolean; message?: string };
  results?: Array<{ ok: boolean; kind: string; error?: string }>;
  failures?: Array<{ kind: string; error?: string }>;
};

type Zone = { id: string; name: string };
type CoolifyServer = { uuid: string; name: string; ip: string };
type CoolifyProject = { uuid: string; name: string };

export default function IntegrationsAdmin({
  initial,
}: {
  initial: {
    integrations: PublicIntegration[];
    alert: { at: string; failures: Array<{ kind: string; error: string }> } | null;
    sentry?: { redirectUrl: string; settingsUrl: string; scopes: readonly string[] };
  };
}) {
  const [integrations, setIntegrations] = useState(initial.integrations);
  const [alert, setAlert] = useState(initial.alert);
  const [busy, setBusy] = useState<string | null>(null);
  const [githubOrg, setGithubOrg] = useState('');
  const [cfToken, setCfToken] = useState('');
  const [zones, setZones] = useState<Zone[] | null>(null);
  const [pickedZone, setPickedZone] = useState('');
  const [coolifyUrl, setCoolifyUrl] = useState('https://coolify.navroop.app');
  const [coolifyToken, setCoolifyToken] = useState('');
  const [servers, setServers] = useState<CoolifyServer[] | null>(null);
  const [projects, setProjects] = useState<CoolifyProject[]>([]);
  const [selectedServers, setSelectedServers] = useState<
    Record<string, { on: boolean; max: number }>
  >({});
  const [projectUuid, setProjectUuid] = useState('');
  const [disconnectKind, setDisconnectKind] = useState<PublicIntegration['kind'] | null>(null);
  const [disconnectConfirm, setDisconnectConfirm] = useState('');
  const [disconnectWarning, setDisconnectWarning] = useState<string | null>(null);
  const [sentryDsn, setSentryDsn] = useState('');
  const [sentryToken, setSentryToken] = useState('');
  const [sentryOauthOpen, setSentryOauthOpen] = useState(false);
  const [sentryClientId, setSentryClientId] = useState('');
  const [sentryClientSecret, setSentryClientSecret] = useState('');
  const [sentryCopied, setSentryCopied] = useState('');
  const [sentryVerify, setSentryVerify] = useState<string | null>(null);
  const [sentryEnv, setSentryEnv] = useState(
    initial.integrations.find((row) => row.kind === 'SENTRY')?.environment || '',
  );
  const [sentrySample, setSentrySample] = useState(
    String(initial.integrations.find((row) => row.kind === 'SENTRY')?.tracesSampleRate ?? 0.1),
  );
  const [sentryReplay, setSentryReplay] = useState(
    Boolean(initial.integrations.find((row) => row.kind === 'SENTRY')?.sessionReplay),
  );
  const [sentryPerf, setSentryPerf] = useState(
    initial.integrations.find((row) => row.kind === 'SENTRY')?.performance !== false,
  );
  const [sentryIgnore, setSentryIgnore] = useState(
    (initial.integrations.find((row) => row.kind === 'SENTRY')?.ignoreList ?? []).join('\n'),
  );
  const [sentryLimit, setSentryLimit] = useState(
    String(initial.integrations.find((row) => row.kind === 'SENTRY')?.fingerprintLimit ?? 10),
  );
  const [sentryWindow, setSentryWindow] = useState(
    String(initial.integrations.find((row) => row.kind === 'SENTRY')?.fingerprintWindowSec ?? 300),
  );
  const [restartConfirm, setRestartConfirm] = useState('');
  const [restartOpen, setRestartOpen] = useState(false);
  const [sentryOrgs, setSentryOrgs] = useState<Array<{ slug: string; name: string }>>([]);
  const [sentryProjects, setSentryProjects] = useState<
    Array<{ id: string; slug: string; name: string }>
  >([]);
  const [sentryOrg, setSentryOrg] = useState('');
  const [sentryProject, setSentryProject] = useState('');
  const sentryMeta = resolveSentryMeta(initial.sentry);

  const byKind = useMemo(
    () =>
      Object.fromEntries(integrations.map((row) => [row.kind, row])) as Record<
        PublicIntegration['kind'],
        PublicIntegration
      >,
    [integrations],
  );

  const applyPayload = (data: { integrations?: PublicIntegration[]; alert?: typeof alert }) => {
    if (Array.isArray(data.integrations)) setIntegrations(data.integrations);
    if ('alert' in data) setAlert(data.alert ?? null);
  };

  /**
   * The HTTP status only says the run happened. `POST /api/admin/integrations/check`
   * answers 200 with the failures in the body, and the Sentry round-trip answers 200
   * with `outcome: 'send_failed'` — so settling on `response.ok` put "All integrations
   * checked." over a revoked Cloudflare token and a green toast over a Sentry ingest
   * 401. The result decides the tone, and the toast names what failed.
   */
  const check = async (kind?: PublicIntegration['kind']) => {
    setBusy(kind ? `check:${kind}` : 'check');
    setSentryVerify(null);
    const toastId = notify.loading(kind ? `Checking ${kind}…` : 'Checking integrations…');
    try {
      const path =
        kind === 'SENTRY' ? '/api/integrations/sentry/verify' : '/api/admin/integrations/check';
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(kind && kind !== 'SENTRY' ? { kind } : {}),
      });
      const data = (await response.json()) as CheckPayload;
      if (!response.ok) {
        notify.settle(toastId, 'error', data.error || 'Check failed');
        return;
      }
      applyPayload(data);
      if (kind === 'SENTRY') {
        if (data.result?.message) setSentryVerify(data.result.message);
        const received = data.result?.received === true;
        notify.settle(
          toastId,
          received ? 'success' : 'warning',
          data.result?.message ||
            (received
              ? 'Sentry received the test event.'
              : 'Sentry did not confirm the test event.'),
        );
        return;
      }
      if (kind) {
        const failed = data.result?.ok !== true;
        notify.settle(
          toastId,
          failed ? 'warning' : 'success',
          failed ? `${kind}: ${data.result?.error || 'check failed'}` : `${kind} checked.`,
        );
        return;
      }
      const failures = data.failures ?? [];
      if (failures.length > 0) {
        const total = data.results?.length ?? failures.length;
        notify.settle(
          toastId,
          'warning',
          `${failures.length} of ${total} integrations failed — ${failures
            .map((row) => `${row.kind}: ${row.error}`)
            .join('; ')}`,
        );
        return;
      }
      notify.settle(toastId, 'success', 'All integrations checked.');
    } catch (cause) {
      notify.settle(toastId, 'error', toMessage(cause, 'Check failed'));
    } finally {
      setBusy(null);
    }
  };

  const connectSentry = async (event: FormEvent) => {
    event.preventDefault();
    setBusy('sentry');
    setSentryVerify(null);
    try {
      const response = await fetch('/api/integrations/sentry/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dsn: sentryDsn, authToken: sentryToken || undefined }),
      });
      const data = await response.json();
      if (!response.ok) {
        notify.error(data.error || 'Sentry did not connect', { key: 'sentry-connect' });
        return;
      }
      applyPayload(data);
      setSentryDsn('');
      setSentryToken('');
      if (data.message) setSentryVerify(data.message);
      notify.success(data.message || 'Sentry connected.', { key: 'sentry-connect' });
    } catch (cause) {
      notify.error(cause, { fallback: 'Sentry did not connect', key: 'sentry-connect' });
    } finally {
      setBusy(null);
    }
  };

  const startSentryOauth = async () => {
    setBusy('sentry-oauth');
    try {
      const response = await fetch('/api/integrations/sentry/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: sentryClientId, clientSecret: sentryClientSecret }),
      });
      const data = await response.json();
      if (!response.ok) {
        notify.error(data.error || 'Could not start Sentry OAuth', { key: 'sentry-oauth' });
        return;
      }
      if (data.url) {
        notify.info('Redirecting to Sentry…', { key: 'sentry-oauth' });
        window.location.assign(data.url);
      } else {
        notify.warning('Sentry did not return a sign-in URL.', { key: 'sentry-oauth' });
      }
    } catch (cause) {
      notify.error(cause, { fallback: 'Could not start Sentry OAuth', key: 'sentry-oauth' });
    } finally {
      setBusy(null);
    }
  };

  const saveSentrySettings = async (event: FormEvent) => {
    event.preventDefault();
    setBusy('sentry-settings');
    try {
      const response = await fetch('/api/integrations/sentry/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          environment: sentryEnv,
          tracesSampleRate: Number(sentrySample),
          sessionReplay: sentryReplay,
          performance: sentryPerf,
          ignoreList: sentryIgnore
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean),
          fingerprintLimit: Number(sentryLimit),
          fingerprintWindowSec: Number(sentryWindow),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        notify.error(data.error || 'Could not save Sentry settings', { key: 'sentry-settings' });
        return;
      }
      applyPayload(data);
      notify.success('Sentry settings saved.', { key: 'sentry-settings' });
    } catch (cause) {
      notify.error(cause, { fallback: 'Could not save Sentry settings', key: 'sentry-settings' });
    } finally {
      setBusy(null);
    }
  };

  const restartApp = async () => {
    setBusy('sentry-restart');
    try {
      const response = await fetch('/api/admin/integrations/sentry/restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: restartConfirm }),
      });
      const data = await response.json();
      if (!response.ok) {
        notify.error(data.error || 'Could not restart the application', { key: 'app-restart' });
        return;
      }
      setRestartOpen(false);
      notify.success('Restart requested — the application is coming back up.', {
        key: 'app-restart',
      });
    } catch (cause) {
      notify.error(cause, { fallback: 'Could not restart the application', key: 'app-restart' });
    } finally {
      setBusy(null);
    }
  };

  const loadSentryOrgs = async () => {
    try {
      const data = await fetchJson<{ orgs?: Array<{ slug: string; name: string }> }>(
        '/api/integrations/sentry/select',
      );
      if (Array.isArray(data.orgs)) {
        setSentryOrgs(data.orgs);
        if (data.orgs.length === 1) setSentryOrg(data.orgs[0].slug);
      }
    } catch (cause) {
      // Previously failed silently, leaving an empty org picker with no reason.
      notify.error(cause, { fallback: 'Could not load Sentry organisations', key: 'sentry-orgs' });
    }
  };

  const loadSentryProjects = async (orgSlug: string) => {
    try {
      const data = await fetchJson<{
        projects?: Array<{ id: string; slug: string; name: string }>;
      }>('/api/integrations/sentry/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgSlug, listProjects: true }),
      });
      if (Array.isArray(data.projects)) setSentryProjects(data.projects);
    } catch (cause) {
      notify.error(cause, { fallback: 'Could not load Sentry projects', key: 'sentry-projects' });
    }
  };

  const finishSentryOauth = async (createProject = false) => {
    if (!sentryOrg) return;
    setBusy('sentry-select');
    try {
      const response = await fetch('/api/integrations/sentry/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgSlug: sentryOrg,
          projectSlug: sentryProject || undefined,
          createProject,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        notify.error(data.error || 'Could not finish Sentry OAuth', { key: 'sentry-select' });
        return;
      }
      applyPayload(data);
      notify.success('Sentry connected.', { key: 'sentry-select' });
    } catch (cause) {
      notify.error(cause, { fallback: 'Could not finish Sentry OAuth', key: 'sentry-select' });
    } finally {
      setBusy(null);
    }
  };

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setSentryCopied(label);
      notify.success('Copied to clipboard.', { key: 'integrations-copy' });
    } catch {
      notify.warning('Could not copy — select the value and copy it by hand.', {
        key: 'integrations-copy',
      });
    }
  };

  const startGithub = (event: FormEvent) => {
    event.preventDefault();
    const org = githubOrg.trim();
    const path = `/api/integrations/github/start${org ? `?org=${encodeURIComponent(org)}` : ''}`;
    window.location.assign(new URL(path, window.location.origin).href);
  };

  const connectCloudflare = async (event: FormEvent) => {
    event.preventDefault();
    setBusy('cf');
    try {
      const response = await fetch('/api/integrations/cloudflare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: cfToken, zoneId: pickedZone || undefined }),
      });
      const data = await response.json();
      if (!response.ok) {
        notify.error(data.error || 'Cloudflare did not connect', { key: 'cloudflare' });
        return;
      }
      applyPayload(data);
      if (data.needsZone && Array.isArray(data.zones)) {
        setZones(data.zones);
        notify.info('Token accepted — now pick the zone to use.', { key: 'cloudflare' });
        return;
      }
      setCfToken('');
      setZones(null);
      notify.success('Cloudflare connected.', { key: 'cloudflare' });
    } catch (cause) {
      notify.error(cause, { fallback: 'Cloudflare did not connect', key: 'cloudflare' });
    } finally {
      setBusy(null);
    }
  };

  const pickZone = async () => {
    if (!pickedZone) return;
    setBusy('cf-zone');
    try {
      const response = await fetch('/api/integrations/cloudflare/zone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zoneId: pickedZone }),
      });
      const data = await response.json();
      if (!response.ok) {
        notify.error(data.error || 'Could not save the zone', { key: 'cloudflare-zone' });
        return;
      }
      applyPayload(data);
      setZones(null);
      setCfToken('');
      notify.success('Cloudflare zone saved.', { key: 'cloudflare-zone' });
    } catch (cause) {
      notify.error(cause, { fallback: 'Could not save the zone', key: 'cloudflare-zone' });
    } finally {
      setBusy(null);
    }
  };

  const discoverCoolify = async (event: FormEvent) => {
    event.preventDefault();
    setBusy('coolify');
    try {
      const response = await fetch('/api/integrations/coolify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: coolifyUrl, token: coolifyToken }),
      });
      const data = await response.json();
      if (!response.ok) {
        notify.error(data.error || 'Coolify did not connect', { key: 'coolify' });
        return;
      }
      const discovered = (data.servers ?? []) as CoolifyServer[];
      setServers(discovered);
      setProjects(data.projects ?? []);
      setSelectedServers(
        Object.fromEntries(discovered.map((row) => [row.uuid, { on: true, max: 50 }])),
      );
      if ((data.projects ?? []).length === 1) setProjectUuid(data.projects[0].uuid);
      notify.success(
        `Coolify connected — found ${discovered.length} server${discovered.length === 1 ? '' : 's'}.`,
        { key: 'coolify' },
      );
    } catch (cause) {
      notify.error(cause, { fallback: 'Coolify did not connect', key: 'coolify' });
    } finally {
      setBusy(null);
    }
  };

  const createProject = async () => {
    setBusy('coolify-project');
    try {
      const response = await fetch('/api/integrations/coolify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: coolifyUrl, token: coolifyToken, createProject: true }),
      });
      const data = await response.json();
      if (!response.ok) {
        notify.error(data.error || 'Could not create the project', { key: 'coolify-project' });
        return;
      }
      setProjects(data.projects ?? []);
      const navroop = (data.projects ?? []).find((row: CoolifyProject) => row.name === 'Navroop');
      if (navroop) setProjectUuid(navroop.uuid);
      notify.success('Coolify project created.', { key: 'coolify-project' });
    } catch (cause) {
      notify.error(cause, { fallback: 'Could not create the project', key: 'coolify-project' });
    } finally {
      setBusy(null);
    }
  };

  const saveCoolify = async () => {
    const chosen = (servers ?? [])
      .filter((row) => selectedServers[row.uuid]?.on)
      .map((row) => ({ ...row, maxDeployments: selectedServers[row.uuid]?.max ?? 50 }));
    setBusy('coolify-save');
    try {
      const response = await fetch('/api/integrations/coolify/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectUuid,
          projectName: projects.find((row) => row.uuid === projectUuid)?.name,
          servers: chosen,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        notify.error(data.error || 'Could not save the servers', { key: 'coolify-save' });
        return;
      }
      applyPayload(data);
      setServers(null);
      setCoolifyToken('');
      notify.success(`Saved ${chosen.length} server${chosen.length === 1 ? '' : 's'}.`, {
        key: 'coolify-save',
      });
    } catch (cause) {
      notify.error(cause, { fallback: 'Could not save the servers', key: 'coolify-save' });
    } finally {
      setBusy(null);
    }
  };

  const openDisconnect = async (kind: PublicIntegration['kind']) => {
    setDisconnectKind(kind);
    setDisconnectConfirm('');
    setDisconnectWarning(null);
    try {
      const response = await fetch('/api/admin/integrations/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, confirm: '' }),
      });
      const data = await response.json().catch(() => ({}));
      if (data.warning) setDisconnectWarning(data.warning);
    } catch (cause) {
      notify.error(cause, { fallback: 'Could not reach the server', key: 'disconnect' });
    }
  };

  const disconnect = async () => {
    if (!disconnectKind) return;
    setBusy('disconnect');
    const kind = disconnectKind;
    try {
      const response = await fetch('/api/admin/integrations/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, confirm: disconnectConfirm }),
      });
      const data = await response.json();
      if (!response.ok) {
        notify.error(data.error || 'Disconnect failed', { key: 'disconnect' });
        setDisconnectWarning(data.warning ?? null);
        return;
      }
      applyPayload(data);
      setDisconnectKind(null);
      setDisconnectConfirm('');
      setDisconnectWarning(data.warning ?? null);
      if (data.stillSendingUntilRestart === true) {
        notify.warning(
          'Restart required — this instance keeps sending events until the app restarts.',
          { key: 'disconnect', autoClose: 12000 },
        );
      } else {
        notify.success(`${kind} disconnected.`, { key: 'disconnect' });
      }
    } catch (cause) {
      notify.error(cause, { fallback: 'Disconnect failed', key: 'disconnect' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <AdminPage
      icon="integrations"
      title="Integrations"
      description="Connect GitHub, Cloudflare, Coolify, and Sentry so projects can be published and monitored."
    >
      {alert && alert.failures.length > 0 && (
        <StatusBanner tone="error">
          <p className="font-medium text-[var(--studio-fg)]">Integration check failed</p>
          {alert.failures.map((row) => (
            <p key={row.kind} className="mt-4 text-[var(--studio-muted)]">
              {row.kind}: {row.error}
            </p>
          ))}
        </StatusBanner>
      )}
      {byKind.SENTRY?.restartRequired && (
        <StatusBanner
          tone="warning"
          action={
            <StudioButton type="button" variant="ghost" onClick={() => setRestartOpen(true)}>
              Restart application
            </StudioButton>
          }
        >
          <p className="font-medium text-[var(--studio-fg)]">
            Restart required — Sentry will start reporting after the application restarts
          </p>
          <p className="mt-4 text-[var(--studio-muted)]">
            Active project id: {byKind.SENTRY.activeProjectId || 'none'} · Configured project id:{' '}
            {byKind.SENTRY.configuredProjectId || 'none'}
          </p>
          <p
            className="mt-4 text-[12px] text-[var(--studio-faint)]"
            title="In Coolify, open the Navroop application and click Restart. Sentry picks up the new DSN only after that restart."
          >
            In Coolify, open the Navroop application and click Restart.
          </p>
        </StatusBanner>
      )}

      <div className="grid gap-16">
        <Card
          row={byKind.GITHUB_DEPLOY}
          busy={busy}
          onCheck={() => void check('GITHUB_DEPLOY')}
          onDisconnect={() => void openDisconnect('GITHUB_DEPLOY')}
        >
          {byKind.GITHUB_DEPLOY?.status !== 'CONNECTED' && (
            <form onSubmit={startGithub} className="mt-16 space-y-12">
              <StudioField
                id="github-org"
                label="Organization login"
                value={githubOrg}
                onChange={(event) => setGithubOrg(event.target.value)}
              />
              <p className="text-[12px] text-[var(--studio-faint)]">
                The organization you want to deploy to
              </p>
              <StudioButton type="submit">Connect GitHub</StudioButton>
            </form>
          )}
          {byKind.GITHUB_DEPLOY?.status === 'CONNECTED' && byKind.GITHUB_DEPLOY.htmlUrl && (
            <a
              href={byKind.GITHUB_DEPLOY.htmlUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-10 inline-block text-[13px] text-[var(--studio-accent)]"
            >
              Open GitHub App
            </a>
          )}
        </Card>

        <Card
          row={byKind.CLOUDFLARE}
          busy={busy}
          onCheck={() => void check('CLOUDFLARE')}
          onDisconnect={() => void openDisconnect('CLOUDFLARE')}
        >
          {byKind.CLOUDFLARE?.status === 'CONNECTED' && byKind.CLOUDFLARE.zoneName && (
            <p className="mt-10 text-[13px] text-[var(--studio-fg)]">
              Sites will be created here: {'{slug}'}.{byKind.CLOUDFLARE.zoneName} and preview-
              {'{slug}'}.{byKind.CLOUDFLARE.zoneName}
            </p>
          )}
          {byKind.CLOUDFLARE?.status !== 'CONNECTED' && (
            <form onSubmit={(event) => void connectCloudflare(event)} className="mt-16 space-y-12">
              <ol className="list-decimal space-y-6 pl-18 text-[13px] text-[var(--studio-muted)]">
                <li>Open the Cloudflare token page with the button below</li>
                <li>Select the permissions — you can copy the chips</li>
                <li>Paste the token and connect</li>
              </ol>
              <StudioButton
                type="button"
                variant="ghost"
                onClick={() =>
                  window.open('https://dash.cloudflare.com/profile/api-tokens', '_blank')
                }
              >
                Open Cloudflare token page
              </StudioButton>
              <div className="flex flex-wrap gap-8">
                <Chip text="Zone → DNS → Edit" />
                <Chip text="Zone → Zone → Read" />
              </div>
              <p className="text-[12px] text-[var(--studio-faint)]">
                In Zone Resources, choose your domain
              </p>
              <StudioField
                id="cf-token"
                label="API token"
                type="password"
                value={cfToken}
                onChange={(event) => setCfToken(event.target.value)}
                autoComplete="off"
                required
              />
              {zones && (
                <label className="block text-[13px] text-[var(--studio-muted)]">
                  Domain
                  <select
                    className="mt-6 h-40 w-full rounded-10 border border-[var(--studio-line)] px-10 text-[13px] text-[var(--studio-fg)]"
                    value={pickedZone}
                    onChange={(event) => setPickedZone(event.target.value)}
                  >
                    <option value="">Select a domain</option>
                    {zones.map((zone) => (
                      <option key={zone.id} value={zone.id}>
                        {zone.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {zones ? (
                <StudioButton
                  type="button"
                  disabled={busy === 'cf-zone'}
                  onClick={() => void pickZone()}
                >
                  Save domain
                </StudioButton>
              ) : (
                <StudioButton type="submit" disabled={busy === 'cf'}>
                  Connect Cloudflare
                </StudioButton>
              )}
            </form>
          )}
        </Card>

        <Card
          row={byKind.COOLIFY}
          busy={busy}
          onCheck={() => void check('COOLIFY')}
          onDisconnect={() => void openDisconnect('COOLIFY')}
        >
          {byKind.COOLIFY?.status !== 'CONNECTED' && (
            <form onSubmit={(event) => void discoverCoolify(event)} className="mt-16 space-y-12">
              <StudioField
                id="coolify-url"
                label="Coolify URL"
                value={coolifyUrl}
                onChange={(event) => setCoolifyUrl(event.target.value)}
                required
              />
              <StudioField
                id="coolify-token"
                label="API token"
                type="password"
                value={coolifyToken}
                onChange={(event) => setCoolifyToken(event.target.value)}
                autoComplete="off"
                required
              />
              <StudioButton type="submit" disabled={busy === 'coolify'}>
                Find servers
              </StudioButton>
            </form>
          )}
          {servers && (
            <div className="mt-16 space-y-12">
              {servers.map((server) => (
                <label key={server.uuid} className="flex items-start gap-10 text-[13px]">
                  <input
                    type="checkbox"
                    checked={Boolean(selectedServers[server.uuid]?.on)}
                    onChange={(event) =>
                      setSelectedServers((current) => ({
                        ...current,
                        [server.uuid]: {
                          on: event.target.checked,
                          max: current[server.uuid]?.max ?? 50,
                        },
                      }))
                    }
                  />
                  <span>
                    <span className="font-medium text-[var(--studio-fg)]">{server.name}</span>
                    <span className="ml-8 text-[var(--studio-muted)]">{server.ip}</span>
                    <input
                      type="number"
                      min={1}
                      className="ml-8 h-32 w-72 rounded-8 border border-[var(--studio-line)] px-6"
                      value={selectedServers[server.uuid]?.max ?? 50}
                      onChange={(event) =>
                        setSelectedServers((current) => ({
                          ...current,
                          [server.uuid]: {
                            on: current[server.uuid]?.on ?? true,
                            max: Number(event.target.value),
                          },
                        }))
                      }
                    />
                  </span>
                </label>
              ))}
              <label className="block text-[13px] text-[var(--studio-muted)]">
                Coolify project
                <select
                  className="mt-6 h-40 w-full rounded-10 border border-[var(--studio-line)] px-10 text-[13px] text-[var(--studio-fg)]"
                  value={projectUuid}
                  onChange={(event) => setProjectUuid(event.target.value)}
                >
                  <option value="">Select a project</option>
                  {projects.map((project) => (
                    <option key={project.uuid} value={project.uuid}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex flex-wrap gap-8">
                <StudioButton
                  type="button"
                  variant="ghost"
                  disabled={busy === 'coolify-project'}
                  onClick={() => void createProject()}
                >
                  Create a new project
                </StudioButton>
                <StudioButton
                  type="button"
                  disabled={busy === 'coolify-save'}
                  onClick={() => void saveCoolify()}
                >
                  Save servers
                </StudioButton>
              </div>
            </div>
          )}
        </Card>

        <Card
          row={byKind.SENTRY}
          busy={busy}
          onCheck={() => void check('SENTRY')}
          onDisconnect={() => void openDisconnect('SENTRY')}
        >
          {byKind.SENTRY?.status === 'CONNECTED' && byKind.SENTRY.limited && (
            <p className="mt-10 text-[13px] text-[var(--studio-muted)]">
              Connected — limited. Add an auth token to enable quota monitoring.
            </p>
          )}
          {sentryVerify && (
            <p className="mt-10 text-[13px] text-[var(--studio-fg)]">{sentryVerify}</p>
          )}
          {byKind.SENTRY?.status === 'PENDING' && (
            <div className="mt-16 space-y-12">
              <p className="text-[13px] text-[var(--studio-muted)]">
                Choose a Sentry organization and project
              </p>
              <StudioButton type="button" variant="ghost" onClick={() => void loadSentryOrgs()}>
                Load organizations
              </StudioButton>
              {sentryOrgs.length > 0 && (
                <label className="block text-[13px] text-[var(--studio-muted)]">
                  Organization
                  <select
                    className="mt-6 h-40 w-full rounded-10 border border-[var(--studio-line)] px-10 text-[13px] text-[var(--studio-fg)]"
                    value={sentryOrg}
                    onChange={(event) => {
                      setSentryOrg(event.target.value);
                      void loadSentryProjects(event.target.value);
                    }}
                  >
                    <option value="">Select an organization</option>
                    {sentryOrgs.map((org) => (
                      <option key={org.slug} value={org.slug}>
                        {org.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {sentryProjects.length > 0 && (
                <label className="block text-[13px] text-[var(--studio-muted)]">
                  Project
                  <select
                    className="mt-6 h-40 w-full rounded-10 border border-[var(--studio-line)] px-10 text-[13px] text-[var(--studio-fg)]"
                    value={sentryProject}
                    onChange={(event) => setSentryProject(event.target.value)}
                  >
                    <option value="">Select a project</option>
                    {sentryProjects.map((project) => (
                      <option key={project.slug} value={project.slug}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className="flex flex-wrap gap-8">
                <StudioButton
                  type="button"
                  variant="ghost"
                  disabled={busy === 'sentry-select'}
                  onClick={() => void finishSentryOauth(true)}
                >
                  Create a new project
                </StudioButton>
                <StudioButton
                  type="button"
                  disabled={busy === 'sentry-select'}
                  onClick={() => void finishSentryOauth(false)}
                >
                  Save project
                </StudioButton>
              </div>
            </div>
          )}
          {byKind.SENTRY?.status !== 'CONNECTED' && byKind.SENTRY?.status !== 'PENDING' && (
            <form onSubmit={(event) => void connectSentry(event)} className="mt-16 space-y-12">
              <StudioField
                id="sentry-dsn"
                label="DSN"
                value={sentryDsn}
                onChange={(event) => setSentryDsn(event.target.value)}
                required
              />
              <StudioField
                id="sentry-token"
                label="Auth token (optional)"
                type="password"
                value={sentryToken}
                onChange={(event) => setSentryToken(event.target.value)}
                autoComplete="off"
              />
              <StudioButton type="submit" disabled={busy === 'sentry'}>
                Connect Sentry
              </StudioButton>
              <button
                type="button"
                className="block text-[13px] text-[var(--studio-accent)]"
                onClick={() => setSentryOauthOpen((open) => !open)}
              >
                {sentryOauthOpen ? 'Hide OAuth setup' : 'Connect with OAuth (complete option)'}
              </button>
              {sentryOauthOpen && (
                <div className="space-y-12 rounded-10 border border-[var(--studio-line)] p-12">
                  <ol className="list-decimal space-y-6 pl-18 text-[13px] text-[var(--studio-muted)]">
                    <li>Open Sentry OAuth app settings with the button below</li>
                    <li>Create an application and paste the redirect URL</li>
                    <li>Copy the scopes, then paste the client id and secret</li>
                  </ol>
                  <StudioButton
                    type="button"
                    variant="ghost"
                    onClick={() => window.open(sentryMeta.settingsUrl, '_blank')}
                  >
                    Open Sentry OAuth app settings
                  </StudioButton>
                  <div className="flex flex-wrap items-center gap-8">
                    <code className="text-[12px] text-[var(--studio-fg)]">
                      {sentryMeta.redirectUrl}
                    </code>
                    <StudioButton
                      type="button"
                      variant="ghost"
                      onClick={() => void copyText(sentryMeta.redirectUrl, 'redirect')}
                    >
                      {sentryCopied === 'redirect' ? 'Copied' : 'Copy redirect URL'}
                    </StudioButton>
                  </div>
                  <div className="flex flex-wrap gap-8">
                    {sentryMeta.scopes.map((scope) => (
                      <Chip key={scope} text={scope} />
                    ))}
                  </div>
                  <StudioField
                    id="sentry-client-id"
                    label="Client id"
                    value={sentryClientId}
                    onChange={(event) => setSentryClientId(event.target.value)}
                  />
                  <StudioField
                    id="sentry-client-secret"
                    label="Client secret"
                    type="password"
                    value={sentryClientSecret}
                    onChange={(event) => setSentryClientSecret(event.target.value)}
                    autoComplete="off"
                  />
                  <StudioButton
                    type="button"
                    disabled={busy === 'sentry-oauth'}
                    onClick={() => void startSentryOauth()}
                  >
                    Continue with OAuth
                  </StudioButton>
                </div>
              )}
            </form>
          )}
          {byKind.SENTRY?.status === 'CONNECTED' && (
            <form onSubmit={(event) => void saveSentrySettings(event)} className="mt-16 space-y-12">
              <StudioField
                id="sentry-env"
                label="Environment name"
                value={sentryEnv}
                onChange={(event) => setSentryEnv(event.target.value)}
              />
              <p className="text-[12px] text-[var(--studio-faint)]">
                Restart required — the environment name is read when Sentry starts
              </p>
              <StudioField
                id="sentry-sample"
                label="Traces sample rate (0–1)"
                value={sentrySample}
                onChange={(event) => setSentrySample(event.target.value)}
              />
              <p className="text-[12px] text-[var(--studio-faint)]">
                Restart required — sample rate changes apply after the application restarts. Higher
                rates use more quota.
              </p>
              <label className="flex items-center gap-8 text-[13px] text-[var(--studio-fg)]">
                <input
                  type="checkbox"
                  checked={sentryReplay}
                  onChange={(event) => setSentryReplay(event.target.checked)}
                />
                Session replay
              </label>
              <p className="text-[12px] text-[var(--studio-faint)]">
                Restart required — session replay is read when Sentry starts
              </p>
              <label className="flex items-center gap-8 text-[13px] text-[var(--studio-fg)]">
                <input
                  type="checkbox"
                  checked={sentryPerf}
                  onChange={(event) => setSentryPerf(event.target.checked)}
                />
                Performance monitoring
              </label>
              <p className="text-[12px] text-[var(--studio-faint)]">
                Restart required — performance monitoring is read when Sentry starts
              </p>
              <label className="block text-[13px] text-[var(--studio-muted)]">
                Ignore list
                <textarea
                  className="mt-6 min-h-80 w-full rounded-10 border border-[var(--studio-line)] px-10 py-8 text-[13px] text-[var(--studio-fg)]"
                  value={sentryIgnore}
                  onChange={(event) => setSentryIgnore(event.target.value)}
                />
              </label>
              <p className="text-[12px] text-[var(--studio-faint)]">
                Applies immediately — no restart required
              </p>
              <StudioField
                id="sentry-limit"
                label="Per-fingerprint rate limit"
                value={sentryLimit}
                onChange={(event) => setSentryLimit(event.target.value)}
              />
              <StudioField
                id="sentry-window"
                label="Rate limit window (seconds)"
                value={sentryWindow}
                onChange={(event) => setSentryWindow(event.target.value)}
              />
              <p className="text-[12px] text-[var(--studio-faint)]">
                Applies immediately — no restart required
              </p>
              <StudioButton type="submit" disabled={busy === 'sentry-settings'}>
                Save settings
              </StudioButton>
            </form>
          )}
        </Card>
      </div>

      {restartOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-20">
          <button
            type="button"
            aria-label="Cancel"
            className="absolute inset-0 bg-[var(--studio-fg)]/20"
            onClick={() => setRestartOpen(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            className="relative z-10 w-full max-w-[420px] rounded-16 border border-[var(--studio-line)] bg-[var(--studio-surface)] p-24 shadow-lg"
          >
            <p className="text-[16px] font-medium text-[var(--studio-fg)]">
              Restart the application?
            </p>
            <p className="mt-8 text-[14px] leading-6 text-[var(--studio-muted)]">
              Type <strong className="text-[var(--studio-fg)]">restart</strong> to confirm. This
              interrupts the application.
            </p>
            <input
              className="mt-12 h-40 w-full rounded-10 border border-[var(--studio-line-strong)] bg-[var(--studio-bg)] px-12 text-[14px] text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
              value={restartConfirm}
              onChange={(event) => setRestartConfirm(event.target.value)}
            />
            <div className="mt-20 flex justify-end gap-8">
              <StudioButton type="button" variant="ghost" onClick={() => setRestartOpen(false)}>
                Cancel
              </StudioButton>
              <StudioButton
                type="button"
                variant="danger"
                disabled={busy === 'sentry-restart' || restartConfirm !== 'restart'}
                onClick={() => void restartApp()}
              >
                {busy === 'sentry-restart' ? 'Restarting…' : 'Restart application'}
              </StudioButton>
            </div>
          </div>
        </div>
      )}
      {disconnectKind && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-20">
          <button
            type="button"
            aria-label="Cancel"
            className="absolute inset-0 bg-[var(--studio-fg)]/20"
            onClick={() => setDisconnectKind(null)}
          />
          <div
            role="dialog"
            aria-modal="true"
            className="relative z-10 w-full max-w-[420px] rounded-16 border border-[var(--studio-line)] bg-[var(--studio-surface)] p-24 shadow-lg"
          >
            <p className="text-[16px] font-medium text-[var(--studio-fg)]">
              Disconnect {byKind[disconnectKind].name}?
            </p>
            {disconnectWarning && (
              <p className="mt-8 text-[13px] text-[var(--studio-danger)]">{disconnectWarning}</p>
            )}
            <p className="mt-8 text-[14px] leading-6 text-[var(--studio-muted)]">
              Type{' '}
              <strong className="text-[var(--studio-fg)]">{byKind[disconnectKind].name}</strong> to
              confirm
            </p>
            <input
              className="mt-12 h-40 w-full rounded-10 border border-[var(--studio-line-strong)] bg-[var(--studio-bg)] px-12 text-[14px] text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
              value={disconnectConfirm}
              onChange={(event) => setDisconnectConfirm(event.target.value)}
            />
            <div className="mt-20 flex justify-end gap-8">
              <StudioButton type="button" variant="ghost" onClick={() => setDisconnectKind(null)}>
                Cancel
              </StudioButton>
              <StudioButton
                type="button"
                variant="danger"
                disabled={
                  busy === 'disconnect' || disconnectConfirm !== byKind[disconnectKind].name
                }
                onClick={() => void disconnect()}
              >
                {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
              </StudioButton>
            </div>
          </div>
        </div>
      )}
    </AdminPage>
  );
}

function Card({
  row,
  busy,
  onCheck,
  onDisconnect,
  children,
}: {
  row?: PublicIntegration;
  busy: string | null;
  onCheck: () => void;
  onDisconnect: () => void;
  children: ReactNode;
}) {
  if (!row) return null;
  const Icon = KIND_ICON[row.kind];
  return (
    <AdminCard
      icon={<Icon className="size-14" aria-hidden />}
      title={row.name}
      description={
        <>
          <StatusPill tone={STATUS_TONE[row.status] ?? 'neutral'}>{row.statusLabel}</StatusPill>
          {row.detail && <span className="mt-6 block">{row.detail}</span>}
          {row.lastError && (
            <span className="mt-6 flex items-start gap-6 text-[var(--studio-danger)]">
              <X className="mt-1 size-11 shrink-0" aria-hidden />
              {row.lastError}
            </span>
          )}
        </>
      }
      actions={
        <>
          <StudioButton
            type="button"
            variant="ghost"
            disabled={busy === `check:${row.kind}`}
            onClick={onCheck}
          >
            {busy === `check:${row.kind}` ? 'Checking…' : 'Check connection'}
          </StudioButton>
          {row.status !== 'DISCONNECTED' && (
            <StudioButton type="button" variant="danger" onClick={onDisconnect}>
              Disconnect
            </StudioButton>
          )}
        </>
      }
    >
      {children}
    </AdminCard>
  );
}

function Chip({ text }: { text: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      notify.success('Copied to clipboard.', { key: 'integrations-copy' });
    } catch {
      notify.warning('Could not copy — select the value and copy it by hand.', {
        key: 'integrations-copy',
      });
    }
  };
  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="rounded-full border border-[var(--studio-line-strong)] px-10 py-6 text-[12px] text-[var(--studio-fg)]"
    >
      {text}
    </button>
  );
}
