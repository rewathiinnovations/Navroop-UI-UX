import * as Sentry from '@sentry/nextjs';
import { currentRelease } from '../deploy/release';
import { heartbeatFailedEmail } from '../email/templates/observability';
import { getInstanceId } from '../runtime/instance';
import { sentryEnvironment } from '../sentry/options';
import { resolveSendAdminEmail } from './alerts';
import { getObservabilityStore } from './store';
import type { ObservabilityStore, SendAdminEmail } from './types';

export const HEARTBEAT_FINGERPRINT = 'observability-heartbeat';
export const HEARTBEAT_FLUSH_TIMEOUT_MS = 5_000;

export type HeartbeatDeps = {
  captureMessage?: (message: string, context?: Record<string, unknown>) => string | undefined;
  flush?: (timeoutMs: number) => Promise<boolean>;
  instanceId?: string;
  environment?: string;
  releaseSha?: string;
  now?: Date;
  store?: Pick<ObservabilityStore, 'createCheck' | 'listChecks'>;
  sendAdminEmail?: SendAdminEmail;
};

export async function sendObservabilityHeartbeat(deps: HeartbeatDeps = {}) {
  const store = deps.store ?? getObservabilityStore();
  const now = deps.now ?? new Date();
  const environment = deps.environment ?? sentryEnvironment();
  const releaseSha = deps.releaseSha ?? currentRelease().sha;
  const instanceId = deps.instanceId ?? getInstanceId();
  const captureMessage =
    deps.captureMessage ?? ((message, context) => Sentry.captureMessage(message, context as never));
  const flush = deps.flush ?? ((timeoutMs) => Sentry.flush(timeoutMs));

  const eventId = captureMessage('Navroop observability heartbeat', {
    level: 'info',
    fingerprint: [HEARTBEAT_FINGERPRINT],
    tags: {
      environment,
      release: releaseSha,
      instanceId,
    },
  });

  let flushOk = false;
  let flushError = '';
  try {
    flushOk = Boolean(await flush(HEARTBEAT_FLUSH_TIMEOUT_MS));
  } catch (error) {
    flushOk = false;
    flushError = error instanceof Error ? error.message : String(error);
  }

  const detail = flushOk
    ? 'flush reported success'
    : flushError
      ? `flush threw: ${flushError}`
      : 'flush reported failure';

  await store.createCheck({
    kind: 'heartbeat',
    ok: flushOk,
    eventId: eventId ?? null,
    detail,
    createdAt: now,
  });

  if (!flushOk) {
    const recent = (await store.listChecks('heartbeat'))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 2);
    if (recent.length >= 2 && recent.every((row) => !row.ok)) {
      await resolveSendAdminEmail(deps.sendAdminEmail)(heartbeatFailedEmail());
    }
  }

  return {
    // Getting one event into Sentry is this cron's entire job, so a flush that failed is work
    // left undone rather than an observation about something else. Without an `ok` here the
    // run recorded `CronRun{ok: true}` while error reporting was dark, and the only escalation
    // waited for two consecutive failures.
    ok: flushOk,
    detail,
    eventId: eventId ?? null,
    flushOk,
    fingerprint: HEARTBEAT_FINGERPRINT,
    environment,
    releaseSha,
    instanceId,
  };
}
