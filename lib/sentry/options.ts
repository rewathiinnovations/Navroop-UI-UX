import { applyImmediateNoiseSettings, observabilityBeforeSend } from '../observability/noise';
import { captureBootRuntimeConfig, readRuntimeConfig } from '../observability/runtime-config';

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

export function buildSentryInitOptions() {
  const config = captureBootRuntimeConfig();
  if (!shouldInitSentry({ config })) return null;
  if (config) {
    applyImmediateNoiseSettings({
      ignoreList: config.ignoreList,
      fingerprintLimit: config.fingerprintLimit,
      fingerprintWindowSec: config.fingerprintWindowSec,
    });
  }
  return {
    dsn: config!.dsn,
    environment: config!.environment || sentryEnvironment(),
    tracesSampleRate: config!.performance === false ? 0 : config!.tracesSampleRate,
    beforeSend: observabilityBeforeSend,
    sendDefaultPii: false,
  };
}
