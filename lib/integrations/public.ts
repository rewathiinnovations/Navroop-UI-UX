import { DEFAULT_WORKSPACE_ID } from '@/lib/publish/constants';
import { getBootRuntimeConfig } from '@/lib/observability/runtime-config';
import { INTEGRATION_KINDS, KIND_LABELS } from './types';
import { statusLabel } from './messages';
import { SECRETS_UNREADABLE_MESSAGE } from './secrets';
import type { DecryptedIntegration } from './store';
import { listIntegrations } from './store';
import { getIntegrationHealthAlert } from './health';
import { sentryOAuthRedirectUrl, sentryOAuthSettingsUrl, sentryRestartBanner } from './sentry';
import { appPublicUrl } from '@/lib/settings/app-url';

export function publicIntegration(
  row: DecryptedIntegration | null,
  kind: DecryptedIntegration['kind'],
) {
  if (!row) {
    return {
      kind,
      name: KIND_LABELS[kind],
      status: 'DISCONNECTED' as const,
      statusLabel: statusLabel('DISCONNECTED'),
      detail: null as string | null,
      lastCheckedAt: null as string | null,
      lastError: null as string | null,
      htmlUrl: null as string | null,
      org: null as string | null,
      zoneName: null as string | null,
      appSlug: null as string | null,
      orgSlug: null as string | null,
      projectSlug: null as string | null,
      projectId: null as string | null,
      limited: false,
      environment: null as string | null,
      tracesSampleRate: null as number | null,
      sessionReplay: false,
      performance: true,
      ignoreList: [] as string[],
      fingerprintLimit: 10,
      fingerprintWindowSec: 300,
      restartRequired: false,
      activeProjectId: null as string | null,
      configuredProjectId: null as string | null,
      oauthClientId: null as string | null,
      repositorySelection: null as 'all' | 'selected' | null,
    };
  }
  let detail: string | null = null;
  if (kind === 'GITHUB_DEPLOY') {
    detail = row.config.accountLogin || row.config.org || null;
  } else if (kind === 'CLOUDFLARE') {
    detail = row.config.zoneName || null;
  } else if (kind === 'COOLIFY') {
    detail = row.config.serverCount != null ? `${row.config.serverCount} servers` : null;
  } else if (kind === 'SENTRY') {
    const org = row.config.orgSlug || null;
    const project = row.config.projectSlug || row.config.projectId || null;
    detail = org && project ? `${org} / ${project}` : project;
  }
  const boot = getBootRuntimeConfig();
  const configuredProjectId = kind === 'SENTRY' ? (row.config.projectId ?? null) : null;
  const banner =
    kind === 'SENTRY'
      ? sentryRestartBanner({
          activeProjectId: boot?.projectId ?? null,
          configuredProjectId,
        })
      : { restartRequired: false, activeProjectId: null, configuredProjectId: null };
  // A row whose credentials will not decrypt is reported as ERROR, not as the CONNECTED its
  // status column still says. The pill's tone comes from `status`, so the previous view
  // showed a green "Connected" over an integration that could not authenticate anything —
  // and only the daily health cron would eventually flip the column (F-212).
  const status = row.secretsUnreadable ? ('ERROR' as const) : row.status;
  return {
    kind,
    name: KIND_LABELS[kind],
    status,
    statusLabel:
      kind === 'SENTRY' && status === 'CONNECTED' && (row.config.limited || !row.secrets.authToken)
        ? 'Connected — limited'
        : statusLabel(status),
    detail,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    lastError: row.secretsUnreadable ? SECRETS_UNREADABLE_MESSAGE : row.lastError,
    htmlUrl: row.config.htmlUrl ?? null,
    org: row.config.org ?? row.config.accountLogin ?? null,
    zoneName: row.config.zoneName ?? null,
    appSlug: row.config.slug ?? null,
    orgSlug: row.config.orgSlug ?? null,
    projectSlug: row.config.projectSlug ?? null,
    projectId: row.config.projectId ?? null,
    limited: Boolean(row.config.limited || (kind === 'SENTRY' && !row.secrets.authToken)),
    environment: row.config.environment ?? null,
    tracesSampleRate: row.config.tracesSampleRate ?? null,
    sessionReplay: Boolean(row.config.sessionReplay),
    performance: row.config.performance !== false,
    ignoreList: row.config.ignoreList ?? [],
    fingerprintLimit: row.config.fingerprintLimit ?? 10,
    fingerprintWindowSec: row.config.fingerprintWindowSec ?? 300,
    restartRequired: banner.restartRequired,
    activeProjectId: banner.activeProjectId,
    configuredProjectId: banner.configuredProjectId,
    oauthClientId: row.config.oauthClientId ?? null,
    // F-270: only meaningful for GITHUB_DEPLOY. `all` means the App's contents+administration
    // write reaches every repository in the account.
    repositorySelection: kind === 'GITHUB_DEPLOY' ? (row.config.repositorySelection ?? null) : null,
  };
}

export async function listPublicIntegrations(workspaceId = DEFAULT_WORKSPACE_ID) {
  const rows = await listIntegrations(workspaceId);
  const byKind = new Map(rows.map((row) => [row.kind, row]));
  return {
    integrations: INTEGRATION_KINDS.map((kind) =>
      publicIntegration(byKind.get(kind) ?? null, kind),
    ),
    alert: await getIntegrationHealthAlert(),
    sentry: {
      redirectUrl: sentryOAuthRedirectUrl(await appPublicUrl()),
      settingsUrl: sentryOAuthSettingsUrl(),
      scopes: ['project:read', 'project:write', 'org:read', 'event:admin'] as const,
    },
  };
}
