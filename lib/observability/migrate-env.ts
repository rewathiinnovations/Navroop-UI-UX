import { parseSentryDsn } from './dsn';

export type MigratedSentryRow = {
  name: string;
  dsn: string;
  projectId: string;
  host: string;
};

type MigrateDeps = {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  getExisting?: () => Promise<{ id: string } | null>;
  createMigrated?: (row: MigratedSentryRow) => Promise<void>;
  log?: (event: string, extra?: Record<string, unknown>) => void;
};

let ran = false;

export function resetSentryEnvMigrateForTests() {
  ran = false;
}

type LoggerModule = {
  log: { info: (event: string, extra?: Record<string, unknown>) => void };
};

/**
 * The default sink for this module's two log lines.
 *
 * Detached on purpose — a log line must not decide whether boot succeeds — but
 * detached still has to mean logged. This used to end in `.catch(() => undefined)`,
 * in the very module whose swallowed second write produced the 2026-08-18
 * `.data/config/observability.json` incident (F-634). A logger that cannot load now
 * falls through to stderr with the event name attached, so the line is degraded
 * rather than gone.
 *
 * `loadLogger` is dynamic to keep `lib/logger` out of this module's import graph, and
 * injectable so the failure path is reachable from a test.
 */
export function logMigrateEvent(
  event: string,
  extra?: Record<string, unknown>,
  loadLogger: () => Promise<LoggerModule> = () => import('../logger'),
) {
  return loadLogger()
    .then(({ log: logger }) => logger.info(event, extra))
    .catch((error: unknown) => {
      console.error(`[observability] ${event} — structured logger unavailable`, {
        ...extra,
        loggerError: error instanceof Error ? error.message : String(error),
      });
    });
}

/** First boot: if no Sentry Integration and legacy SENTRY_DSN is set, migrate it. Then the env var is ignored. */
export async function migrateEnvSentry(deps: MigrateDeps = {}) {
  if (ran && !deps.getExisting && !deps.createMigrated) {
    return { migrated: false, ignored: false };
  }
  const env = deps.env ?? process.env;
  const log = deps.log ?? logMigrateEvent;
  const dsn = env.SENTRY_DSN?.trim() || env.NEXT_PUBLIC_SENTRY_DSN?.trim() || '';
  const getExisting =
    deps.getExisting ??
    (async () => {
      const { getIntegration } = await import('../integrations/store');
      const { DEFAULT_WORKSPACE_ID } = await import('../publish/constants');
      const row = await getIntegration(DEFAULT_WORKSPACE_ID, 'SENTRY');
      return row ? { id: row.id } : null;
    });
  const existing = await getExisting();
  if (existing) {
    if (dsn) {
      log('sentry.env_ignored', {
        message: 'SENTRY_DSN is ignored because a Sentry Integration already exists',
      });
    }
    ran = true;
    return { migrated: false, ignored: Boolean(dsn) };
  }
  if (!dsn) {
    ran = true;
    return { migrated: false, ignored: false };
  }
  const parsed = parseSentryDsn(dsn);
  if (!parsed) {
    ran = true;
    return { migrated: false, ignored: false, invalid: true as const };
  }
  const row: MigratedSentryRow = {
    name: 'Sentry (migrated)',
    dsn,
    projectId: parsed.projectId,
    host: parsed.host,
  };
  // `persistSentryConnection` writes the Integration row and then the runtime file, so it
  // is the single writer here. A second write from this module could only ever disagree
  // with the row, and when a caller injects `createMigrated` it owns persistence.
  if (deps.createMigrated) {
    await deps.createMigrated(row);
  } else {
    const { persistSentryConnection } = await import('../integrations/sentry-persist');
    await persistSentryConnection({
      dsn,
      projectId: parsed.projectId,
      host: parsed.host,
      environment: env.SENTRY_ENVIRONMENT?.trim() || env.NODE_ENV || 'production',
      limited: !env.SENTRY_AUTH_TOKEN?.trim(),
      authToken: env.SENTRY_AUTH_TOKEN?.trim() || undefined,
      orgSlug: env.SENTRY_ORG?.trim() || undefined,
      projectSlug: env.SENTRY_PROJECT?.trim() || undefined,
      installationName: 'Sentry (migrated)',
    });
  }
  log('sentry.env_migrated', {
    message: 'Created Sentry (migrated) from SENTRY_DSN. The env var is now ignored.',
  });
  ran = true;
  return { migrated: true, ignored: false };
}

export function sentryEnvMigrateRan() {
  return ran;
}
