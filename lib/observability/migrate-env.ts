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

/** First boot: if no Sentry Integration and legacy SENTRY_DSN is set, migrate it. Then the env var is ignored. */
export async function migrateEnvSentry(deps: MigrateDeps = {}) {
  if (ran && !deps.getExisting && !deps.createMigrated) {
    return { migrated: false, ignored: false };
  }
  const env = deps.env ?? process.env;
  const log =
    deps.log ??
    ((event: string, extra?: Record<string, unknown>) => {
      void import('../logger').then(({ log: logger }) => logger.info(event, extra)).catch(() => undefined);
    });
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
