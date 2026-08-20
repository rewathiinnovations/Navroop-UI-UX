import { currentRelease } from '../deploy/release';
import { sentryDsn, sentryEnvironment } from '../sentry/options';
import { HEARTBEAT_FINGERPRINT } from './heartbeat';
import { dsnProjectId } from './dsn';
import { createSentryApi, sentryApiConfigured } from './sentry-api';
import { getObservabilityStore } from './store';
import { evaluateSystemChecks } from './system-checks';
import type { ErrorTrackingPanel, ObservabilityStore, SentryApi, SentryDropped } from './types';

const TEST_FINGERPRINT = 'observability-test';
/**
 * How long the admin request waits for Sentry to acknowledge the test event. It waited
 * 60s, longer than the Traefik/Coolify default, so the admin got a gateway timeout and
 * learned nothing — the one question the button exists to answer (F-761). An unconfirmed
 * send is now an answer of its own: the event id is returned either way.
 */
const TEST_CONFIRM_WAIT_MS = 10_000;
const TEST_POLL_MS = 2_000;

export function buildErrorTrackingPanel(input: {
  dsnConfigured: boolean;
  dsnProjectId: string | null;
  environment: string;
  releaseSha: string;
  lastSuccessfulSendAt: string | null;
  lastConfirmedReceiptAt: string | null;
  quota: { used: number; limit: number | null; resetsAt: string | null } | null;
  dropped24h: SentryDropped[];
  topIssues: Array<{ id: string; title: string; count: number }>;
}): ErrorTrackingPanel {
  let status: ErrorTrackingPanel['status'] = 'Healthy';
  if (!input.dsnConfigured || !input.lastSuccessfulSendAt) {
    status = 'Not reporting';
  } else if (
    !input.lastConfirmedReceiptAt ||
    Date.parse(input.lastConfirmedReceiptAt) < Date.parse(input.lastSuccessfulSendAt)
  ) {
    status = 'Degraded';
  } else if (
    input.quota &&
    input.quota.limit !== null &&
    input.quota.limit > 0 &&
    input.quota.used / input.quota.limit >= 0.8
  ) {
    status = 'Degraded';
  } else if (input.dropped24h.some((row) => row.count > 0)) {
    // Events reaching Sentry and being discarded there is not a healthy project (F-632).
    status = 'Degraded';
  }

  return {
    status,
    lastSuccessfulSendAt: input.lastSuccessfulSendAt,
    lastConfirmedReceiptAt: input.lastConfirmedReceiptAt,
    quota: input.quota,
    dropped24h: input.dropped24h,
    topIssues: input.topIssues.slice(0, 5),
    dsnProjectId: input.dsnProjectId,
    environment: input.environment,
    releaseSha: input.releaseSha,
    dsnConfigured: input.dsnConfigured,
  };
}

export async function loadErrorTrackingPanel(
  deps: {
    store?: Pick<ObservabilityStore, 'listChecks'>;
    sentryApi?: SentryApi;
    credentials?: { authToken?: string; orgSlug?: string; projectSlug?: string } | null;
  } = {},
): Promise<ErrorTrackingPanel> {
  const store = deps.store ?? getObservabilityStore();
  const dsn = sentryDsn();
  const heartbeats = await store.listChecks('heartbeat');
  const lastSuccessfulSend = heartbeats.find((row) => row.ok) ?? null;

  let lastConfirmedReceiptAt: string | null = null;
  let quota: ErrorTrackingPanel['quota'] = null;
  let dropped24h: SentryDropped[] = [];
  let topIssues: ErrorTrackingPanel['topIssues'] = [];

  const credentials =
    deps.credentials !== undefined
      ? deps.credentials
      : await (await import('../integrations/sentry-credentials')).loadSentryApiCredentials();

  if (deps.sentryApi || sentryApiConfigured(credentials ?? {})) {
    try {
      const api = deps.sentryApi ?? createSentryApi(credentials ?? {});
      const [issue, stats] = await Promise.all([
        api.findIssueByFingerprint(HEARTBEAT_FINGERPRINT),
        api.getProjectStats(),
      ]);
      lastConfirmedReceiptAt = issue?.lastSeen ?? null;
      quota = stats.quota;
      dropped24h = stats.dropped;
      topIssues = stats.topIssues.slice(0, 5);
    } catch {
      // Local timestamps still render when the Sentry API is unavailable.
    }
  }

  return buildErrorTrackingPanel({
    dsnConfigured: Boolean(dsn),
    dsnProjectId: dsnProjectId(dsn),
    environment: sentryEnvironment(),
    releaseSha: currentRelease().sha,
    lastSuccessfulSendAt: lastSuccessfulSend?.createdAt.toISOString() ?? null,
    lastConfirmedReceiptAt,
    quota,
    dropped24h,
    topIssues,
  });
}

export async function loadSystemChecks(
  deps: { store?: Pick<ObservabilityStore, 'listLatestCronRunPerName'>; now?: Date } = {},
) {
  const store = deps.store ?? getObservabilityStore();
  const runs = await store.listLatestCronRunPerName();
  return evaluateSystemChecks(runs, deps.now ?? new Date());
}

export type TestEventDeps = {
  captureMessage?: (message: string, context?: Record<string, unknown>) => string | undefined;
  flush?: (timeoutMs: number) => Promise<boolean>;
  findIssueByFingerprint?: (
    fingerprint: string,
  ) => Promise<{ id: string; lastSeen: string } | null>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export async function sendObservabilityTestEvent(deps: TestEventDeps = {}) {
  const captureMessage =
    deps.captureMessage ??
    (async (message: string, context?: Record<string, unknown>) => {
      const Sentry = await import('@sentry/nextjs');
      return Sentry.captureMessage(message, context as never);
    });
  const flush =
    deps.flush ??
    (async (timeoutMs: number) => {
      const Sentry = await import('@sentry/nextjs');
      return Sentry.flush(timeoutMs);
    });
  const findIssue =
    deps.findIssueByFingerprint ??
    (async (fingerprint: string) => {
      const { loadSentryApiCredentials } = await import('../integrations/sentry-credentials');
      const credentials = await loadSentryApiCredentials();
      return createSentryApi(credentials ?? {}).findIssueByFingerprint(fingerprint);
    });
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());

  const eventId = await captureMessage('Navroop observability test event', {
    level: 'info',
    fingerprint: [TEST_FINGERPRINT],
    tags: { observability: 'test', kind: 'admin-test' },
  });
  await flush(5_000);

  const started = now();
  let confirmError: string | null = null;
  for (;;) {
    let issue: { id: string; lastSeen: string } | null = null;
    try {
      issue = await findIssue(TEST_FINGERPRINT);
    } catch (error) {
      // The Sentry API rejects on failure (F-631). "We could not ask" is not "the event
      // did not arrive", so it is reported as its own reason rather than as a miss.
      confirmError = error instanceof Error ? error.message : String(error);
      break;
    }
    if (issue) {
      return {
        outcome: 'received' as const,
        received: true,
        eventId: eventId ?? null,
        lastSeen: issue.lastSeen,
        waitedMs: now() - started,
        confirmError: null,
      };
    }
    if (now() - started + TEST_POLL_MS >= TEST_CONFIRM_WAIT_MS) break;
    await sleep(TEST_POLL_MS);
  }
  return {
    outcome: 'sent_unconfirmed' as const,
    received: false,
    eventId: eventId ?? null,
    lastSeen: null,
    waitedMs: now() - started,
    confirmError,
  };
}
