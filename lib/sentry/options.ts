import { log } from '../logger';
import { applyImmediateNoiseSettings, observabilityBeforeSend } from '../observability/noise';
import type { RuntimeConfigRead } from '../observability/runtime-config';
import {
  captureBootRuntimeConfigState,
  readRuntimeConfig,
  runtimeConfigPath,
} from '../observability/runtime-config';

export function sentryDsn() {
  const config = readRuntimeConfig();
  if (config?.enabled && config.dsn.trim()) return config.dsn.trim();
  return '';
}

export function sentryTracesSampleRate() {
  const config = readRuntimeConfig();
  if (config?.performance === false) return 0;
  if (typeof config?.tracesSampleRate === 'number') return config.tracesSampleRate;
  return process.env.NODE_ENV === 'production' ? 0.1 : 1.0;
}

export function sentryEnvironment() {
  const config = readRuntimeConfig();
  if (config?.environment?.trim()) return config.environment.trim();
  return process.env.NODE_ENV || 'development';
}

export function shouldInitSentry(input?: {
  config?: { enabled?: boolean; dsn?: string } | null;
  nodeEnv?: string;
}) {
  if (input && 'config' in input) {
    return Boolean(input.config?.enabled && input.config.dsn?.trim());
  }
  return Boolean(sentryDsn());
}

/**
 * Whether `Sentry.init` ran in this process, and if not, why. `dsnConfigured` on
 * `/api/health` reads the file live, so it goes green the moment a broken config is
 * repaired — over a process that stays blind until it restarts (F-738).
 *
 * `not_captured` means no boot read happened here: the edge runtime, or a test. It is not
 * evidence of anything, in the same way `describeDataDir`'s `not_checked` is not.
 */
export type SentryInitState =
  'initialised' | 'skipped_absent' | 'skipped_unreadable' | 'skipped_disabled' | 'not_captured';

export function describeSentryInit(read: RuntimeConfigRead | null): SentryInitState {
  if (!read) return 'not_captured';
  if (read.state === 'absent') return 'skipped_absent';
  if (read.state === 'unreadable') return 'skipped_unreadable';
  return shouldInitSentry({ config: read.config }) ? 'initialised' : 'skipped_disabled';
}

export function buildSentryInitOptions() {
  const read = captureBootRuntimeConfigState();
  if (read.state !== 'ok' || !shouldInitSentry({ config: read.config })) {
    // An absent file is the ordinary "Sentry is not connected" state and the startup check
    // reports it. A file that could not be read is different: error reporting is off for
    // the life of this process because of a filesystem problem, and before F-738 nothing
    // said so at the point where the decision was taken.
    if (read.state === 'unreadable') {
      log.error('sentry.init_skipped_unreadable_config', {
        path: runtimeConfigPath(),
        code: read.code,
        error: read.message,
        detail:
          'Sentry.init was skipped because the observability config file could not be read. Error tracking is off until this container is restarted with a readable file.',
      });
    }
    return null;
  }
  const config = read.config;
  applyImmediateNoiseSettings({
    ignoreList: config.ignoreList,
    fingerprintLimit: config.fingerprintLimit,
    fingerprintWindowSec: config.fingerprintWindowSec,
  });
  return {
    dsn: config.dsn,
    environment: config.environment || sentryEnvironment(),
    tracesSampleRate: config.performance === false ? 0 : config.tracesSampleRate,
    beforeSend: observabilityBeforeSend,
    sendDefaultPii: false,
  };
}
