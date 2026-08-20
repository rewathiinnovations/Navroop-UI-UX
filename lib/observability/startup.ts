import { currentRelease } from '../deploy/release';
import { dsnMissingEmail } from '../email/templates/observability';
import { log, logError } from '../logger';
import { sentryDsn, sentryEnvironment } from '../sentry/options';
import { resolveSendAdminEmail } from './alerts';
import { parseSentryDsn } from './dsn';
import { getObservabilityStore } from './store';
import type { ObservabilityStore, SendAdminEmail } from './types';

export type StartupDeps = {
  nodeEnv?: string;
  dsn?: string;
  environment?: string;
  releaseSha?: string;
  now?: Date;
  store?: Pick<ObservabilityStore, 'createCheck'>;
  warn?: (message: string) => void;
  sendAdminEmail?: SendAdminEmail;
  /** Reads the `AppSetting` marker recording the last alert this release already sent. */
  getAlerted?: () => Promise<string | null>;
  /** Writes that marker; `null` clears it. */
  setAlerted?: (value: string | null) => Promise<void>;
};

/**
 * One `AppSetting` row, holding `reason:releaseSha` for the last alert that went out. It
 * is the whole of the F-739 fix: observability mail is `emailClass: 'security'` and so
 * exempt from the per-recipient rate-limit bucket, and there was no already-alerted flag,
 * so a crash-looping production container mailed every admin every few seconds about a
 * configuration state that had not changed. `maybeAlertLowSpace` stores exactly one such
 * marker for the same reason.
 */
export const DSN_ALERT_MARKER_KEY = 'observability.dsnAlert';

async function readAlertMarker(deps: StartupDeps) {
  if (deps.getAlerted) return deps.getAlerted();
  const { prisma } = await import('../db');
  const row = await prisma.appSetting.findUnique({ where: { key: DSN_ALERT_MARKER_KEY } });
  return row?.value ?? null;
}

async function writeAlertMarker(deps: StartupDeps, value: string | null) {
  if (deps.setAlerted) return deps.setAlerted(value);
  const { prisma } = await import('../db');
  if (value === null) {
    // deleteMany, not delete: clearing a marker that was never set is the normal case.
    await prisma.appSetting.deleteMany({ where: { key: DSN_ALERT_MARKER_KEY } });
    return;
  }
  await prisma.appSetting.upsert({
    where: { key: DSN_ALERT_MARKER_KEY },
    create: { key: DSN_ALERT_MARKER_KEY, value },
    update: { value },
  });
}

export async function runObservabilityStartup(deps: StartupDeps = {}) {
  const nodeEnv = deps.nodeEnv ?? process.env.NODE_ENV ?? 'development';
  if (nodeEnv !== 'production') {
    return {
      ran: false,
      dsnConfigured: Boolean((deps.dsn ?? sentryDsn()).trim()),
      skipped: true as const,
    };
  }

  const dsn = (deps.dsn ?? sentryDsn()).trim();
  const environment = deps.environment ?? sentryEnvironment();
  const releaseSha = deps.releaseSha ?? currentRelease().sha;
  const now = deps.now ?? new Date();
  const store = deps.store ?? getObservabilityStore();
  const warn =
    deps.warn ?? ((message: string) => log.warn(message, { action: 'observability-startup' }));

  if (!dsn) {
    const message =
      'Sentry is not connected in production. Error tracking is not reporting. This is not the same as having no errors.';
    warn(message);
    // The check row is written on every boot regardless of the marker: it is the health
    // signal, and suppressing it would trade an alert storm for an invisible outage.
    await store.createCheck({
      kind: 'dsn_config',
      ok: false,
      eventId: null,
      detail: JSON.stringify({ environment, releaseSha, reason: 'missing_dsn' }),
      createdAt: now,
    });
    const marker = `missing_dsn:${releaseSha}`;
    let alreadyAlerted: string | null;
    try {
      alreadyAlerted = await readAlertMarker(deps);
    } catch (error) {
      // The admin address list comes from the same database, so a marker read that failed
      // is a database that could not have delivered this mail either. Reported upward and
      // logged, never turned into an unbounded send.
      const alertMarkerError = error instanceof Error ? error.message : String(error);
      logError('observability.dsn_alert_marker_unreadable', error, { releaseSha });
      return {
        ran: true,
        dsnConfigured: false,
        environment,
        releaseSha,
        alerted: false,
        alertMarkerError,
      };
    }
    if (alreadyAlerted === marker) {
      return { ran: true, dsnConfigured: false, environment, releaseSha, alerted: false };
    }
    await resolveSendAdminEmail(deps.sendAdminEmail)(dsnMissingEmail());
    await writeAlertMarker(deps, marker);
    return { ran: true, dsnConfigured: false, environment, releaseSha, alerted: true };
  }

  // A DSN is present, so the "not connected" alert may fire again if it ever disappears.
  // Clearing here rather than only on success covers the invalid-DSN path too: the
  // configuration has changed since the alert went out, which is what the marker tracks.
  try {
    await writeAlertMarker(deps, null);
  } catch (error) {
    // A marker that stays set means no further missing-DSN email is ever sent, so the
    // failure mode is permanent silence. Logged loudly; the boot continues.
    logError('observability.dsn_alert_marker_stale', error, { releaseSha });
  }

  const parsed = parseSentryDsn(dsn);
  if (!parsed) {
    warn('The Sentry DSN is present but invalid. Error tracking will not report correctly.');
    await store.createCheck({
      kind: 'dsn_config',
      ok: false,
      eventId: null,
      detail: JSON.stringify({ environment, releaseSha, reason: 'invalid_dsn' }),
      createdAt: now,
    });
    return { ran: true, dsnConfigured: true, valid: false, environment, releaseSha };
  }

  await store.createCheck({
    kind: 'dsn_config',
    ok: true,
    eventId: null,
    detail: JSON.stringify({ environment, releaseSha, projectId: parsed.projectId }),
    createdAt: now,
  });
  return {
    ran: true,
    dsnConfigured: true,
    valid: true,
    environment,
    releaseSha,
    projectId: parsed.projectId,
  };
}
