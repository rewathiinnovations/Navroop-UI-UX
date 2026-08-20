import { log } from '../logger';
import type { ObservabilityRuntimeConfig, RuntimeConfigRead } from './runtime-config';
import { readRuntimeConfigState, runtimeConfigDiffers, writeRuntimeConfig } from './runtime-config';

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

export function runtimeConfigFromIntegration(
  row: ConnectedSentry | null,
): ObservabilityRuntimeConfig | null {
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

/**
 * After DB is available: rewrite the volume file when it drifted from the Integration row.
 *
 * The read is the three-state one (F-738). "Could not read the file" and "there is no
 * file" both end in a rewrite — the Integration row is the source of truth and the volume
 * is a cache — but only one of them means something was wrong with the volume, and the
 * two-state read could not tell the caller which happened.
 */
export async function reconcileRuntimeConfig(
  deps: {
    getConnected?: () => Promise<ConnectedSentry | null>;
    read?: () => RuntimeConfigRead;
    write?: (config: ObservabilityRuntimeConfig) => void;
  } = {},
) {
  const getConnected =
    deps.getConnected ??
    (async () => {
      // Dynamic so this module stays importable from boot before the DB client is wanted.
      const { getIntegration } = await import('../integrations/store');
      const { DEFAULT_WORKSPACE_ID } = await import('../publish/constants');
      const row = await getIntegration(DEFAULT_WORKSPACE_ID, 'SENTRY');
      if (!row) return null;
      return { status: row.status, config: row.config };
    });
  const read = deps.read ?? readRuntimeConfigState;
  const write = deps.write ?? writeRuntimeConfig;
  const connected = await getConnected();
  const next = runtimeConfigFromIntegration(connected);
  const current = read();
  const unreadable = current.state === 'unreadable';
  if (!next) return { rewrote: false as const, unreadable };
  if (!runtimeConfigDiffers(current.state === 'ok' ? current.config : null, next)) {
    return { rewrote: false as const, unreadable };
  }
  write(next);
  if (unreadable) {
    // The read failure itself is logged by `readRuntimeConfigState`; this line is the
    // other half of the story, and the half an operator needs: it is fixed now.
    log.info('observability.runtime_config_repaired', {
      projectId: next.projectId,
      previousError: current.message,
    });
  }
  return { rewrote: true as const, projectId: next.projectId, unreadable };
}
