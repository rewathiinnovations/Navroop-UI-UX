import { DEFAULT_WORKSPACE_ID } from '@/lib/publish/constants';
import type { SentryApiCredentials } from '@/lib/observability/sentry-api';
import { getIntegration } from './store';

export async function loadSentryApiCredentials(
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<SentryApiCredentials | null> {
  const row = await getIntegration(workspaceId, 'SENTRY');
  if (!row || row.status === 'DISCONNECTED') return null;
  return {
    authToken: row.secrets.authToken,
    orgSlug: row.config.orgSlug,
    projectSlug: row.config.projectSlug,
  };
}

export function sentryConnectionLimited(row: {
  secrets?: { authToken?: string };
  config?: { limited?: boolean };
} | null) {
  if (!row) return true;
  if (row.config?.limited) return true;
  return !row.secrets?.authToken?.trim();
}
