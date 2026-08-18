import { heartbeatMismatchEmail, quotaWarningEmail } from '../email/templates/observability';
import { HEARTBEAT_FINGERPRINT } from './heartbeat';
import { resolveSendAdminEmail } from './alerts';
import { createSentryApi, sentryApiConfigured, type SentryApiCredentials } from './sentry-api';
import { getObservabilityStore } from './store';
import type { ObservabilityStore, SentryApi, SendAdminEmail } from './types';

const MISMATCH_MS = 3 * 60 * 60 * 1000;

export type QuotaCheckDeps = {
  credentials?: SentryApiCredentials | null;
  now?: Date;
  store?: Pick<ObservabilityStore, 'createCheck' | 'listChecks'>;
  sentryApi?: SentryApi;
  sendAdminEmail?: SendAdminEmail;
};

async function resolveQuotaCredentials(deps: QuotaCheckDeps): Promise<SentryApiCredentials | null> {
  if (deps.credentials !== undefined) return deps.credentials;
  const { loadSentryApiCredentials } = await import('../integrations/sentry-credentials');
  return loadSentryApiCredentials();
}

export async function runObservabilityQuotaCheck(deps: QuotaCheckDeps = {}) {
  const now = deps.now ?? new Date();
  const store = deps.store ?? getObservabilityStore();
  const sendAdmin = resolveSendAdminEmail(deps.sendAdminEmail);
  const credentials = await resolveQuotaCredentials(deps);

  if (!credentials?.authToken?.trim()) {
    await store.createCheck({
      kind: 'quota',
      ok: false,
      eventId: null,
      detail: 'skipped: auth token missing',
      createdAt: now,
    });
    return { status: 'skipped' as const, ok: false, quotaWarning: false };
  }

  if (!sentryApiConfigured(credentials) && !deps.sentryApi) {
    await store.createCheck({
      kind: 'quota',
      ok: false,
      eventId: null,
      detail: 'skipped: org or project missing',
      createdAt: now,
    });
    return { status: 'skipped' as const, ok: false, quotaWarning: false };
  }

  const api = deps.sentryApi ?? createSentryApi(credentials);
  const stats = await api.getProjectStats();
  const issue = await api.findIssueByFingerprint(HEARTBEAT_FINGERPRINT);

  const localOk = (await store.listChecks('heartbeat')).some(
    (row) => row.ok && now.getTime() - row.createdAt.getTime() <= 24 * 60 * 60 * 1000,
  );
  const lastSeenMs = issue?.lastSeen ? Date.parse(issue.lastSeen) : NaN;
  const receiptStale = Number.isNaN(lastSeenMs) || now.getTime() - lastSeenMs > MISMATCH_MS;
  const mismatch = localOk && receiptStale;

  const quotaRatio = stats.quota.limit > 0 ? stats.quota.used / stats.quota.limit : 0;
  const quotaWarning = quotaRatio >= 0.8;
  const droppedWarning = stats.dropped.some(
    (row) => (row.reason === 'rate_limit' || row.reason === 'rate_limited' || row.reason === 'quota') && row.count > 0,
  );

  if (mismatch) {
    await sendAdmin(heartbeatMismatchEmail());
  }
  if (quotaWarning) {
    await sendAdmin(quotaWarningEmail({ used: stats.quota.used, limit: stats.quota.limit, topIssues: stats.topIssues }));
  }

  await store.createCheck({
    kind: 'quota',
    ok: !mismatch && !quotaWarning,
    eventId: issue?.id ?? null,
    detail: JSON.stringify({
      accepted: stats.accepted,
      dropped: stats.dropped,
      quota: stats.quota,
      lastSeen: issue?.lastSeen ?? null,
      mismatch,
      quotaWarning,
      droppedWarning,
    }),
    createdAt: now,
  });

  return {
    status: mismatch ? ('mismatch' as const) : ('ok' as const),
    ok: !mismatch && !quotaWarning,
    quotaWarning,
    droppedWarning,
    stats,
    lastSeen: issue?.lastSeen ?? null,
  };
}
