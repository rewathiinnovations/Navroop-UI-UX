import { randomUUID } from 'node:crypto';
import { parseSentryDsn } from '@/lib/observability/dsn';
import { createSentryApi } from '@/lib/observability/sentry-api';
import { verifySentryRoundTrip } from './sentry';
import { loadSentryApiCredentials } from './sentry-credentials';
import { getIntegration } from './store';
import { DEFAULT_WORKSPACE_ID } from '@/lib/publish/constants';

export async function sendDsnVerificationEvent(dsn: string) {
  const parsed = parseSentryDsn(dsn);
  if (!parsed)
    return {
      ok: false as const,
      error: 'The Sentry DSN is malformed. Check the URL, project id, and public key.',
    };
  const eventId = randomUUID().replace(/-/g, '');
  const url = `${parsed.protocol}://${parsed.host}/api/${parsed.projectId}/store/`;
  const publicKey = (() => {
    try {
      return new URL(dsn).username;
    } catch {
      return '';
    }
  })();
  const payload = {
    event_id: eventId,
    timestamp: new Date().toISOString(),
    platform: 'javascript',
    message: 'Navroop Sentry verification',
    tags: { observability: 'connect', kind: 'dsn-verify' },
    extra: { source: 'navroop-integrations' },
  };
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=navroop/1.0.0, sentry_key=${publicKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return { ok: false as const, eventId, error: `Sentry ingest HTTP ${response.status}` };
    }
    return { ok: true as const, eventId };
  } catch (error) {
    return {
      ok: false as const,
      eventId,
      error:
        error instanceof Error
          ? error.message
          : 'Could not send the verification event (transport error).',
    };
  }
}

export async function runSentryRoundTrip(workspaceId = DEFAULT_WORKSPACE_ID) {
  const row = await getIntegration(workspaceId, 'SENTRY');
  const dsn = row?.config.dsn?.trim() || '';
  const credentials = await loadSentryApiCredentials(workspaceId);
  const api = credentials?.authToken ? createSentryApi(credentials) : null;
  return verifySentryRoundTrip({
    send: async () => {
      if (!dsn) return { ok: false, error: 'Sentry DSN is missing' };
      return sendDsnVerificationEvent(dsn);
    },
    poll: async () => {
      if (!api) return null;
      try {
        return await api.findIssueByFingerprint('navroop-sentry-verify');
      } catch {
        // The API now rejects on failure (F-631). For the verify round trip a
        // failed poll is a miss, not a crash: the loop keeps polling and the
        // user still gets the sent_not_received outcome, as before.
        return null;
      }
    },
    getStats: api ? () => api.getProjectStats() : undefined,
  });
}
