import { DEFAULT_WORKSPACE_ID } from '@/lib/publish/constants';
import { applyImmediateNoiseSettings } from '@/lib/observability/noise';
import { disableRuntimeConfig, writeRuntimeConfig } from '@/lib/observability/runtime-config';
import { log } from '@/lib/logger';
import type { SentryConfig, SentrySecrets } from './types';
import { disconnectIntegration, setIntegrationLastError, upsertIntegration } from './store';

export function sentryRuntimeFromConfig(config: SentryConfig) {
  return {
    enabled: Boolean(config.dsn?.trim()),
    dsn: config.dsn?.trim() || '',
    projectId: config.projectId?.trim() || '',
    environment: config.environment?.trim() || process.env.NODE_ENV || 'development',
    tracesSampleRate: config.tracesSampleRate ?? 0.1,
    sessionReplay: Boolean(config.sessionReplay),
    performance: config.performance !== false,
    ignoreList: config.ignoreList ?? [],
    fingerprintLimit: config.fingerprintLimit ?? 10,
    fingerprintWindowSec: config.fingerprintWindowSec ?? 300,
    orgSlug: config.orgSlug,
    projectSlug: config.projectSlug,
    region: config.region,
  };
}

export async function persistSentryConnection(input: {
  dsn: string;
  projectId: string;
  host: string;
  environment: string;
  limited: boolean;
  authToken?: string;
  refreshToken?: string;
  clientSecret?: string;
  tokenExpiresAt?: string;
  orgSlug?: string;
  projectSlug?: string;
  region?: string;
  installationUuid?: string;
  installationName?: string;
  connectedById?: string;
  tracesSampleRate?: number;
  sessionReplay?: boolean;
  performance?: boolean;
  ignoreList?: string[];
  fingerprintLimit?: number;
  fingerprintWindowSec?: number;
}) {
  const config: SentryConfig = {
    orgSlug: input.orgSlug,
    projectSlug: input.projectSlug,
    projectId: input.projectId,
    dsn: input.dsn,
    environment: input.environment,
    tracesSampleRate: input.tracesSampleRate ?? (process.env.NODE_ENV === 'production' ? 0.1 : 1),
    region: input.region,
    installationUuid: input.installationUuid,
    installationName: input.installationName,
    host: input.host,
    sessionReplay: input.sessionReplay ?? false,
    performance: input.performance ?? true,
    ignoreList: input.ignoreList ?? [],
    fingerprintLimit: input.fingerprintLimit ?? 10,
    fingerprintWindowSec: input.fingerprintWindowSec ?? 300,
    limited: input.limited,
  };
  const secrets: SentrySecrets = {
    authToken: input.authToken,
    refreshToken: input.refreshToken,
    clientSecret: input.clientSecret,
    tokenExpiresAt: input.tokenExpiresAt,
  };
  await upsertIntegration({
    workspaceId: DEFAULT_WORKSPACE_ID,
    kind: 'SENTRY',
    status: 'CONNECTED',
    config,
    secrets,
    connectedById: input.connectedById,
    lastError: input.limited ? 'Connected — limited. Add an auth token to enable quota monitoring.' : null,
    lastCheckedAt: new Date(),
  });
  writeRuntimeConfig(sentryRuntimeFromConfig(config));
  applyImmediateNoiseSettings({
    ignoreList: config.ignoreList,
    fingerprintLimit: config.fingerprintLimit,
    fingerprintWindowSec: config.fingerprintWindowSec,
  });
  return config;
}

export async function persistSentrySettings(input: SentryConfig & { connectedById?: string }) {
  const { connectedById, ...config } = input;
  await upsertIntegration({
    workspaceId: DEFAULT_WORKSPACE_ID,
    kind: 'SENTRY',
    status: 'CONNECTED',
    config,
    connectedById,
  });
  writeRuntimeConfig(sentryRuntimeFromConfig(input));
  applyImmediateNoiseSettings({
    ignoreList: input.ignoreList,
    fingerprintLimit: input.fingerprintLimit,
    fingerprintWindowSec: input.fingerprintWindowSec,
  });
}

export const SENTRY_STILL_SENDING_WARNING =
  'Disconnected, but the runtime file on the volume could not be rewritten, so this instance keeps sending events to the previously configured Sentry project. Restart the app to stop it.';

/**
 * The row is gone the moment `disconnectIntegration` returns, so this cannot fail the
 * operation — there is nothing left to roll back and nothing for the operator to retry.
 * What it must not do is stay quiet: if the volume file still says `enabled: true`, the SDK
 * keeps reporting into a project the operator believes is disconnected. So the failure is
 * logged and written to the row's `lastError`, which `/admin/integrations` and
 * `/admin/health` both already render.
 */
export async function disconnectSentry() {
  await disconnectIntegration({ kind: 'SENTRY' });
  try {
    disableRuntimeConfig();
    return { ok: true as const, stillSendingUntilRestart: false as const };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('sentry.disconnect_runtime_file_failed', {
      message: SENTRY_STILL_SENDING_WARNING,
      error: message,
    });
    await setIntegrationLastError({ kind: 'SENTRY', message: SENTRY_STILL_SENDING_WARNING }).catch(
      (writeError: unknown) => {
        log.error('sentry.disconnect_warning_not_recorded', {
          error: writeError instanceof Error ? writeError.message : String(writeError),
        });
      },
    );
    return {
      ok: true as const,
      stillSendingUntilRestart: true as const,
      warning: SENTRY_STILL_SENDING_WARNING,
      error: message,
    };
  }
}
