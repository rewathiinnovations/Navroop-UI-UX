import type { ObservabilityRuntimeConfig } from './runtime-config';
import {
  readRuntimeConfig,
  runtimeConfigDiffers,
  writeRuntimeConfig,
} from './runtime-config';

export type ConnectedSentry = {
  status: string;
  config: {
    dsn?: string;
    projectId?: string;
    environment?: string;
    tracesSampleRate?: number;
    sessionReplay?: boolean;
    performance?: boolean;
    ignoreList?: string[];
    fingerprintLimit?: number;
    fingerprintWindowSec?: number;
    orgSlug?: string;
    projectSlug?: string;
    region?: string;
  };
};

export function runtimeConfigFromIntegration(row: ConnectedSentry | null): ObservabilityRuntimeConfig | null {
  if (!row || row.status !== 'CONNECTED') {
    return {
      enabled: false,
      dsn: '',
      projectId: '',
      environment: process.env.NODE_ENV || 'development',
      tracesSampleRate: 0.1,
      sessionReplay: false,
      performance: false,
      ignoreList: [],
      fingerprintLimit: 10,
      fingerprintWindowSec: 300,
    };
  }
  const dsn = row.config.dsn?.trim() || '';
  if (!dsn) return null;
  return {
    enabled: true,
    dsn,
    projectId: row.config.projectId?.trim() || '',
    environment: row.config.environment?.trim() || process.env.NODE_ENV || 'development',
    tracesSampleRate: row.config.tracesSampleRate ?? 0.1,
    sessionReplay: Boolean(row.config.sessionReplay),
    performance: row.config.performance !== false,
    ignoreList: row.config.ignoreList ?? [],
    fingerprintLimit: row.config.fingerprintLimit ?? 10,
    fingerprintWindowSec: row.config.fingerprintWindowSec ?? 300,
    orgSlug: row.config.orgSlug,
    projectSlug: row.config.projectSlug,
    region: row.config.region,
  };
}

/** After DB is available: rewrite the volume file when it drifted from the Integration row. */
export async function reconcileRuntimeConfig(deps: {
  getConnected?: () => Promise<ConnectedSentry | null>;
  read?: () => ObservabilityRuntimeConfig | null;
  write?: (config: ObservabilityRuntimeConfig) => void;
} = {}) {
  const getConnected =
    deps.getConnected ??
    (async () => {
      const { getIntegration } = await import('../integrations/store');
      const { DEFAULT_WORKSPACE_ID } = await import('../publish/constants');
      const row = await getIntegration(DEFAULT_WORKSPACE_ID, 'SENTRY');
      if (!row) return null;
      return { status: row.status, config: row.config };
    });
  const read = deps.read ?? readRuntimeConfig;
  const write = deps.write ?? writeRuntimeConfig;
  const connected = await getConnected();
  const next = runtimeConfigFromIntegration(connected);
  const current = read();
  if (!next) return { rewrote: false as const };
  if (!runtimeConfigDiffers(current, next)) return { rewrote: false as const };
  write(next);
  return { rewrote: true as const, projectId: next.projectId };
}
