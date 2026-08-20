import { parseSentryDsn } from '@/lib/observability/dsn';
import type { SentryProjectStats } from '@/lib/observability/types';

export const SENTRY_OAUTH_SCOPES = [
  'project:read',
  'project:write',
  'org:read',
  'event:admin',
] as const;

/**
 * The fingerprint the verification event is sent with and the poll searches for.
 *
 * One constant because they were two literals that had drifted: the event carried tags and no
 * fingerprint at all, while the poll queried `fingerprint:navroop-sentry-verify`. The round
 * trip could therefore never succeed, and every Verify ended after sixty seconds of polling
 * with "Event sent but not received. Likely causes: quota exhausted, rate limited, inbound
 * filter, or wrong project" — an accusation against a correctly configured integration
 * (F-226). Both ends read this name; they cannot drift again.
 */
export const SENTRY_VERIFY_FINGERPRINT = 'navroop-sentry-verify';

export const SENTRY_COPY = {
  malformedDsn: 'The Sentry DSN is malformed. Check the URL, project id, and public key.',
  limited: 'Connected — limited. Add an auth token to enable quota monitoring.',
  verified: 'Connected and verified',
  sentNotReceived:
    'Event sent but not received. Likely causes: quota exhausted, rate limited, inbound filter, or wrong project.',
  sendFailed: 'Could not send the verification event (transport error).',
  restartRequired: 'Restart required — Sentry will start reporting after the application restarts',
  disconnectWarning:
    'Error tracking will stop after the next restart. You will not be notified of application errors.',
  missingProjectRead: 'Auth token is missing the project:read scope',
  refreshFailed: 'Sentry token refresh failed. Reconnect Sentry to restore quota monitoring.',
  // A token with no refresh material and no recorded expiry. It may work; nothing here can
  // say so, and that is the state the operator needs to see (F-237).
  unrefreshable:
    'The Sentry auth token cannot be refreshed and its expiry is unknown, so quota monitoring will stop without warning. Reconnect Sentry.',
  quotaSkipped: 'skipped: auth token missing',
  // Sentry returned a token without saying what it can do. Stored as limited rather than
  // accepted as fully scoped (F-236).
  scopesUnconfirmed:
    'Connected — limited. Sentry did not report this token\u2019s permissions, so quota monitoring may fail. Reconnect if issue or quota data does not appear.',
  coolifyRestartTooltip:
    'In Coolify, open the Navroop application and click Restart. Sentry picks up the new DSN only after that restart.',
  restartConfirm: 'Type restart to confirm. This interrupts the application.',
};

export const SENTRY_FIELD_HINTS = {
  environment: 'Restart required — the environment name is read when Sentry starts',
  tracesSampleRate:
    'Restart required — sample rate changes apply after the application restarts. Higher rates use more quota.',
  sessionReplay: 'Restart required — session replay is read when Sentry starts',
  performance: 'Restart required — performance monitoring is read when Sentry starts',
  ignoreList: 'Applies immediately — no restart required',
  fingerprintLimit: 'Applies immediately — no restart required',
  fingerprintWindowSec: 'Applies immediately — no restart required',
};

export function sentryOAuthRedirectUrl(baseUrl: string) {
  return `${baseUrl.replace(/\/+$/, '')}/api/integrations/sentry/callback`;
}

export function sentryOAuthSettingsUrl() {
  return 'https://sentry.io/settings/account/applications/';
}

export function validateSentryDsn(dsn: string) {
  const parsed = parseSentryDsn(dsn);
  if (!parsed) {
    return { ok: false as const, error: SENTRY_COPY.malformedDsn };
  }
  return { ok: true as const, parsed };
}

export function settingsChangeRequiresRestart(change: {
  environment?: string;
  tracesSampleRate?: number;
  sessionReplay?: boolean;
  performance?: boolean;
  ignoreList?: string[];
  fingerprintLimit?: number;
  fingerprintWindowSec?: number;
}) {
  return (
    change.environment !== undefined ||
    change.tracesSampleRate !== undefined ||
    change.sessionReplay !== undefined ||
    change.performance !== undefined
  );
}

export function sentryRestartBanner(input: {
  activeProjectId: string | null;
  configuredProjectId: string | null;
}) {
  const active = input.activeProjectId?.trim() || null;
  const configured = input.configuredProjectId?.trim() || null;
  const restartRequired = active !== configured;
  return {
    restartRequired,
    activeProjectId: active,
    configuredProjectId: configured,
    message: restartRequired ? SENTRY_COPY.restartRequired : null,
  };
}

export type SentryVerificationSend = () => Promise<{
  ok: boolean;
  eventId?: string | null;
  error?: string;
}>;
export type SentryVerificationPoll = () => Promise<{ id: string; lastSeen: string } | null>;

export async function verifySentryRoundTrip(deps: {
  send: SentryVerificationSend;
  poll: SentryVerificationPoll;
  getStats?: () => Promise<SentryProjectStats | null>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  pollMs?: number;
}) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? 60_000;
  const pollMs = deps.pollMs ?? 2_000;

  const sent = await deps.send();
  if (!sent.ok) {
    return {
      outcome: 'send_failed' as const,
      received: false,
      eventId: sent.eventId ?? null,
      message: sent.error || SENTRY_COPY.sendFailed,
    };
  }

  const started = now();
  while (now() - started < timeoutMs) {
    const issue = await deps.poll();
    if (issue) {
      return {
        outcome: 'received' as const,
        received: true,
        eventId: sent.eventId ?? null,
        lastSeen: issue.lastSeen,
        message: SENTRY_COPY.verified,
      };
    }
    await sleep(pollMs);
  }

  const stats = deps.getStats ? await deps.getStats().catch(() => null) : null;
  const quotaNamed =
    stats?.dropped.some(
      (row) => /quota|rate_limit|rate_limited/i.test(row.reason) && row.count > 0,
    ) || (stats?.quota.limit ? stats.quota.used / stats.quota.limit >= 1 : false);
  const message = quotaNamed
    ? `${SENTRY_COPY.sentNotReceived} Quota is exhausted or events are being dropped.`
    : SENTRY_COPY.sentNotReceived;

  return {
    outcome: 'sent_not_received' as const,
    received: false,
    eventId: sent.eventId ?? null,
    message,
    quota: stats?.quota ?? null,
    dropped: stats?.dropped ?? [],
  };
}

export type ConnectSentryDeps = {
  dsn: string;
  authToken?: string;
  environment?: string;
  sendVerification: SentryVerificationSend;
  inspectToken?: () => Promise<{
    ok: boolean;
    missingScope?: string;
    orgSlug?: string;
    projectSlug?: string;
  }>;
  persist?: (input: {
    dsn: string;
    projectId: string;
    host: string;
    authToken?: string;
    limited: boolean;
    orgSlug?: string;
    projectSlug?: string;
    environment: string;
  }) => Promise<void>;
};

export async function connectSentryWithDsn(deps: ConnectSentryDeps) {
  const validated = validateSentryDsn(deps.dsn);
  if (!validated.ok) return validated;

  const token = deps.authToken?.trim() || '';
  let orgSlug: string | undefined;
  let projectSlug: string | undefined;
  if (token) {
    if (!deps.inspectToken) {
      return { ok: false as const, error: SENTRY_COPY.missingProjectRead };
    }
    const inspected = await deps.inspectToken();
    if (!inspected.ok) {
      return {
        ok: false as const,
        error:
          inspected.missingScope === 'project:read'
            ? SENTRY_COPY.missingProjectRead
            : inspected.missingScope
              ? `Auth token is missing the ${inspected.missingScope} scope`
              : SENTRY_COPY.missingProjectRead,
      };
    }
    orgSlug = inspected.orgSlug;
    projectSlug = inspected.projectSlug;
  }

  const sent = await deps.sendVerification();
  if (!sent.ok) {
    return { ok: false as const, error: sent.error || SENTRY_COPY.sendFailed };
  }

  const limited = !token;
  const environment = deps.environment?.trim() || process.env.NODE_ENV || 'development';
  await deps.persist?.({
    dsn: deps.dsn.trim(),
    projectId: validated.parsed.projectId,
    host: validated.parsed.host,
    authToken: token || undefined,
    limited,
    orgSlug,
    projectSlug,
    environment,
  });

  return {
    ok: true as const,
    limited,
    restartRequired: true,
    projectId: validated.parsed.projectId,
    host: validated.parsed.host,
    eventId: sent.eventId ?? null,
    message: limited ? SENTRY_COPY.limited : SENTRY_COPY.verified,
  };
}
