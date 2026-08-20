import {
  eventsDroppedEmail,
  heartbeatMismatchEmail,
  quotaWarningEmail,
} from '../email/templates/observability';
import { HEARTBEAT_FINGERPRINT } from './heartbeat';
import { resolveSendAdminEmail } from './alerts';
import { createSentryApi, sentryApiConfigured, type SentryApiCredentials } from './sentry-api';
import { getObservabilityStore } from './store';
import { percentSetting } from '../settings/numbers';
import type {
  ObservabilityStore,
  SendAdminEmail,
  SentryApi,
  SentryIssueHit,
  SentryProjectStats,
} from './types';

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

type QuotaAlertFlags = { mismatch: boolean; quotaWarning: boolean; droppedWarning: boolean };

const NO_ALERTS: QuotaAlertFlags = { mismatch: false, quotaWarning: false, droppedWarning: false };

/**
 * Which conditions the previous run of this check already mailed about. The flags live in
 * the `detail` JSON that run wrote, so there is no second store to keep in sync — and an
 * unreadable or absent detail (a `skipped:` row, a schema change) means "we do not know",
 * which sends the mail. Losing an alert is the failure that matters here.
 */
async function previousQuotaAlerts(
  store: Pick<ObservabilityStore, 'listChecks'>,
  now: Date,
): Promise<QuotaAlertFlags> {
  const previous = (await store.listChecks('quota'))
    .filter((row) => row.createdAt.getTime() <= now.getTime())
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (!previous?.detail) return NO_ALERTS;
  try {
    const parsed = JSON.parse(previous.detail) as Partial<QuotaAlertFlags>;
    return {
      mismatch: parsed.mismatch === true,
      quotaWarning: parsed.quotaWarning === true,
      droppedWarning: parsed.droppedWarning === true,
    };
  } catch {
    return NO_ALERTS;
  }
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
  let stats: SentryProjectStats;
  let issue: SentryIssueHit | null;
  try {
    stats = await api.getProjectStats();
    issue = await api.findIssueByFingerprint(HEARTBEAT_FINGERPRINT);
  } catch (error) {
    // The API call itself failed. That is not a healthy, quiet project, and it
    // is not a heartbeat mismatch either — record a skip and fail the run so
    // handleCron turns it into a failed CronRun (F-631).
    const message = error instanceof Error ? error.message : String(error);
    await store.createCheck({
      kind: 'quota',
      ok: false,
      eventId: null,
      detail: `skipped: sentry API unreachable: ${message}`,
      createdAt: now,
    });
    return { status: 'skipped' as const, ok: false, quotaWarning: false };
  }

  const localOk = (await store.listChecks('heartbeat')).some(
    (row) => row.ok && now.getTime() - row.createdAt.getTime() <= 24 * 60 * 60 * 1000,
  );
  const lastSeenMs = issue?.lastSeen ? Date.parse(issue.lastSeen) : NaN;
  const receiptStale = Number.isNaN(lastSeenMs) || now.getTime() - lastSeenMs > MISMATCH_MS;
  const mismatch = localOk && receiptStale;

  // A `null` limit means Sentry reports no per-project rate limit. There is then no
  // ratio to warn about — inventing one mailed every admin daily (F-723).
  const limit = stats.quota.limit;
  const quotaRatio = limit !== null && limit > 0 ? stats.quota.used / limit : null;
  // `app.sentryQuotaWarnPercent` on /admin/config; 80 is the default (F-793). Where a
  // "getting close to the cap" warning fires is an operator preference, and Sentry plans
  // differ enough that one number cannot be right for everyone.
  const warnPercent = await percentSetting('app.sentryQuotaWarnPercent', 80);
  const quotaWarning = quotaRatio !== null && quotaRatio * 100 >= warnPercent;
  const droppedRows = stats.dropped.filter(
    (row) =>
      (row.reason === 'rate_limit' || row.reason === 'rate_limited' || row.reason === 'quota') &&
      row.count > 0,
  );
  const droppedWarning = droppedRows.length > 0;

  // Every alert here repeats daily for as long as the condition holds, and this check has
  // no dedupe of its own the way `heartbeat.ts` requires two consecutive failures — so a
  // standing condition mailed every admin every day until they filtered the sender
  // (F-723). The previous `quota` row already carries which conditions were true when it
  // was written, so it is the flag: mail on the transition into a condition, not on every
  // observation of it. The `CronRun` row stays red either way.
  const alerted = await previousQuotaAlerts(store, now);
  if (mismatch && !alerted.mismatch) {
    await sendAdmin(heartbeatMismatchEmail());
  }
  if (quotaWarning && limit !== null) {
    if (!alerted.quotaWarning) {
      await sendAdmin(
        quotaWarningEmail({
          used: stats.quota.used,
          limit,
          topIssues: stats.topIssues,
          dropped: droppedRows,
        }),
      );
    }
  } else if (droppedWarning && !alerted.droppedWarning) {
    // Events are being discarded while the ratio is still low — an inbound filter or a
    // per-key rate limit. This was computed, stored in `detail`, and told to nobody
    // (F-632), and `ok` said the project was fine while it threw errors away.
    await sendAdmin(eventsDroppedEmail({ dropped: droppedRows, topIssues: stats.topIssues }));
  }

  const ok = !mismatch && !quotaWarning && !droppedWarning;

  await store.createCheck({
    kind: 'quota',
    ok,
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
    ok,
    quotaWarning,
    droppedWarning,
    stats,
    lastSeen: issue?.lastSeen ?? null,
  };
}
