import { DEFAULT_WORKSPACE_ID } from '@/lib/publish/constants';
import type { SentryApiCredentials } from '@/lib/observability/sentry-api';
import { getIntegration } from './store';

export async function loadSentryApiCredentials(
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<SentryApiCredentials | null> {
  const row = await getIntegration(workspaceId, 'SENTRY');
  if (!row || row.status === 'DISCONNECTED') return null;
  // An undecryptable blob is not "no auth token": returning a credentials object with an
  // empty token made the quota path record `skipped: auth token missing`, which reads as
  // "nobody configured one" (F-212). Refusing here keeps the real reason visible on the row.
  if (row.secretsUnreadable) return null;
  return {
    authToken: row.secrets.authToken,
    orgSlug: row.config.orgSlug,
    projectSlug: row.config.projectSlug,
  };
}

export function sentryConnectionLimited(
  row: {
    secrets?: { authToken?: string };
    config?: { limited?: boolean };
  } | null,
) {
  if (!row) return true;
  if (row.config?.limited) return true;
  return !row.secrets?.authToken?.trim();
}
