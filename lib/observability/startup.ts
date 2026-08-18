import { currentRelease } from '../deploy/release';
import { dsnMissingEmail } from '../email/templates/observability';
import { log } from '../logger';
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
};

export async function runObservabilityStartup(deps: StartupDeps = {}) {
  const nodeEnv = deps.nodeEnv ?? process.env.NODE_ENV ?? 'development';
  if (nodeEnv !== 'production') {
    return { ran: false, dsnConfigured: Boolean((deps.dsn ?? sentryDsn()).trim()), skipped: true as const };
  }

  const dsn = (deps.dsn ?? sentryDsn()).trim();
  const environment = deps.environment ?? sentryEnvironment();
  const releaseSha = deps.releaseSha ?? currentRelease().sha;
  const now = deps.now ?? new Date();
  const store = deps.store ?? getObservabilityStore();
  const warn = deps.warn ?? ((message: string) => log.warn(message, { action: 'observability-startup' }));

  if (!dsn) {
    const message =
      'Sentry is not connected in production. Error tracking is not reporting. This is not the same as having no errors.';
    warn(message);
    await store.createCheck({
      kind: 'dsn_config',
      ok: false,
      eventId: null,
      detail: JSON.stringify({ environment, releaseSha, reason: 'missing_dsn' }),
      createdAt: now,
    });
    await resolveSendAdminEmail(deps.sendAdminEmail)(dsnMissingEmail());
    return { ran: true, dsnConfigured: false, environment, releaseSha };
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
  return { ran: true, dsnConfigured: true, valid: true, environment, releaseSha, projectId: parsed.projectId };
}
