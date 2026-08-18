import { HEARTBEAT_FINGERPRINT } from '@/lib/observability/heartbeat';
import { createSentryApi } from '@/lib/observability/sentry-api';
import { DEFAULT_WORKSPACE_ID } from '@/lib/publish/constants';
import { SENTRY_COPY } from './sentry';
import { ensureSentryAccessToken } from './sentry-oauth';
import { getIntegration } from './store';

const LAST_SEEN_STALE_MS = 3 * 60 * 60 * 1000;

export async function checkSentryHealth(workspaceId = DEFAULT_WORKSPACE_ID) {
  const row = await getIntegration(workspaceId, 'SENTRY');
  if (!row || row.status === 'DISCONNECTED') {
    throw new Error('Not connected');
  }
  const token = row.secrets.authToken?.trim();
  if (!token) {
    if (!row.config.dsn?.trim()) throw new Error('Sentry DSN is missing');
    return;
  }
  const refreshed = await ensureSentryAccessToken(row);
  if (!refreshed.ok) {
    throw new Error(refreshed.error || SENTRY_COPY.refreshFailed);
  }
  const org = row.config.orgSlug?.trim();
  const project = row.config.projectSlug?.trim();
  if (!org || !project) {
    throw new Error('Sentry org or project is missing');
  }
  const api = createSentryApi({
    authToken: refreshed.authToken,
    orgSlug: org,
    projectSlug: project,
  });
  const stats = await api.getProjectStats();
  if (!stats) throw new Error('Sentry project was not found');
  const issue = await api.findIssueByFingerprint(HEARTBEAT_FINGERPRINT);
  const lastSeenMs = issue?.lastSeen ? Date.parse(issue.lastSeen) : NaN;
  if (Number.isNaN(lastSeenMs) || Date.now() - lastSeenMs > LAST_SEEN_STALE_MS) {
    throw new Error('Sentry heartbeat lastSeen is not recent');
  }
}
