import '../setup/env';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testPrismaClient } from '../setup/db';
import { DEFAULT_WORKSPACE_ID } from '../../lib/publish/constants';

/**
 * A CONNECTED Sentry Integration whose runtime file names a different project is worse
 * than no Sentry at all: the SDK reports into a project nobody is watching. These tests
 * assert the database row and the runtime file agree after every write path, using the
 * real test database for the row.
 */
const prisma = testPrismaClient();

const DSN_A = 'https://publickey@o123.ingest.sentry.io/111111';
const DSN_B = 'https://otherkey@o123.ingest.sentry.io/222222';

let dir: string;
let previousPath: string | undefined;

function readFile() {
  const path = process.env.OBSERVABILITY_CONFIG_PATH;
  if (!path || !existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as {
    enabled: boolean;
    dsn: string;
    projectId: string;
  };
}

async function readRow() {
  return prisma.integration.findUnique({
    where: { workspaceId_kind: { workspaceId: DEFAULT_WORKSPACE_ID, kind: 'SENTRY' } },
    select: { status: true, config: true },
  });
}

function rowProjectId(config: unknown) {
  if (!config || typeof config !== 'object') return '';
  const value = (config as { projectId?: unknown }).projectId;
  return typeof value === 'string' ? value.trim() : '';
}

beforeAll(async () => {
  await prisma.workspace.upsert({
    where: { id: DEFAULT_WORKSPACE_ID },
    create: { id: DEFAULT_WORKSPACE_ID, storageBytes: 0 },
    update: {},
  });
});

afterAll(async () => {
  await prisma.integration
    .delete({ where: { workspaceId_kind: { workspaceId: DEFAULT_WORKSPACE_ID, kind: 'SENTRY' } } })
    .catch(() => undefined);
  await prisma.$disconnect();
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'navroop-obs-db-'));
  previousPath = process.env.OBSERVABILITY_CONFIG_PATH;
  process.env.OBSERVABILITY_CONFIG_PATH = join(dir, 'observability.json');
  await prisma.integration
    .delete({ where: { workspaceId_kind: { workspaceId: DEFAULT_WORKSPACE_ID, kind: 'SENTRY' } } })
    .catch(() => undefined);
});

afterEach(() => {
  if (previousPath === undefined) delete process.env.OBSERVABILITY_CONFIG_PATH;
  else process.env.OBSERVABILITY_CONFIG_PATH = previousPath;
  rmSync(dir, { recursive: true, force: true });
});

describe('sentry runtime file versus the Integration row', () => {
  it('leaves the file and the row naming the same project after connect', async () => {
    const { persistSentryConnection } = await import('../../lib/integrations/sentry-persist');
    await persistSentryConnection({
      dsn: DSN_A,
      projectId: '111111',
      host: 'o123.ingest.sentry.io',
      environment: 'production',
      limited: true,
    });

    const row = await readRow();
    const file = readFile();
    expect(row?.status).toBe('CONNECTED');
    expect(file?.projectId).toBe('111111');
    expect(file?.projectId).toBe(rowProjectId(row?.config));
    expect(file?.enabled).toBe(true);
  });

  it('moves the file with the row when settings change the project', async () => {
    const { persistSentryConnection, persistSentrySettings } = await import(
      '../../lib/integrations/sentry-persist'
    );
    await persistSentryConnection({
      dsn: DSN_A,
      projectId: '111111',
      host: 'o123.ingest.sentry.io',
      environment: 'production',
      limited: true,
    });
    await persistSentrySettings({
      dsn: DSN_B,
      projectId: '222222',
      host: 'o123.ingest.sentry.io',
      environment: 'production',
      tracesSampleRate: 0.1,
      sessionReplay: false,
      performance: true,
      ignoreList: [],
      fingerprintLimit: 10,
      fingerprintWindowSec: 300,
    });

    const row = await readRow();
    const file = readFile();
    expect(file?.projectId).toBe('222222');
    expect(file?.projectId).toBe(rowProjectId(row?.config));
  });

  it('disables the file when Sentry is disconnected', async () => {
    const { persistSentryConnection, disconnectSentry } = await import(
      '../../lib/integrations/sentry-persist'
    );
    await persistSentryConnection({
      dsn: DSN_A,
      projectId: '111111',
      host: 'o123.ingest.sentry.io',
      environment: 'production',
      limited: true,
    });
    await disconnectSentry();

    const row = await readRow();
    const file = readFile();
    expect(row?.status).toBe('DISCONNECTED');
    expect(file?.enabled).toBe(false);
    expect(file?.projectId).toBe('');
  });

  it('rewrites a file that names another project back to the connected row at boot', async () => {
    const { persistSentryConnection } = await import('../../lib/integrations/sentry-persist');
    await persistSentryConnection({
      dsn: DSN_A,
      projectId: '111111',
      host: 'o123.ingest.sentry.io',
      environment: 'production',
      limited: true,
    });

    // Exactly the drift an operator would report: the file names a project the row does not.
    const path = process.env.OBSERVABILITY_CONFIG_PATH ?? '';
    writeFileSync(
      path,
      `${JSON.stringify({ enabled: true, dsn: DSN_B, projectId: '222222', environment: 'production' })}\n`,
      'utf8',
    );
    expect(readFile()?.projectId).toBe('222222');

    const { reconcileRuntimeConfig } = await import('../../lib/observability/boot');
    const result = await reconcileRuntimeConfig();

    const row = await readRow();
    expect(result.rewrote).toBe(true);
    expect(readFile()?.projectId).toBe('111111');
    expect(readFile()?.projectId).toBe(rowProjectId(row?.config));
  });

  /**
   * `writeRuntimeConfig` is one of the few writers here that rethrows, and `disconnectSentry`
   * used to re-swallow it. The row was deleted while the file still said `enabled: true` with
   * the old DSN, so the app kept reporting into a project the operator believed was
   * disconnected — and nothing said so anywhere.
   */
  it('reports and records "still sending until restart" when the runtime file cannot be rewritten', async () => {
    const { persistSentryConnection, disconnectSentry, SENTRY_STILL_SENDING_WARNING } = await import(
      '../../lib/integrations/sentry-persist'
    );
    await persistSentryConnection({
      dsn: DSN_A,
      projectId: '111111',
      host: 'o123.ingest.sentry.io',
      environment: 'production',
      limited: true,
    });
    expect(readFile()?.enabled).toBe(true);

    // An unwritable config path: the parent is a regular file, so mkdir cannot create it.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'not a directory', 'utf8');
    process.env.OBSERVABILITY_CONFIG_PATH = join(blocker, 'observability.json');

    const result = await disconnectSentry();

    // Not a thrown error: the row is already gone and there is nothing to retry.
    expect(result.ok).toBe(true);
    expect(result.stillSendingUntilRestart).toBe(true);

    const row = await prisma.integration.findUnique({
      where: { workspaceId_kind: { workspaceId: DEFAULT_WORKSPACE_ID, kind: 'SENTRY' } },
      select: { status: true, lastError: true },
    });
    expect(row?.status).toBe('DISCONNECTED');
    // `lastError` is rendered by /admin/health and /admin/integrations, so this is where an
    // operator finds out the instance has not actually stopped reporting yet.
    expect(row?.lastError).toBe(SENTRY_STILL_SENDING_WARNING);
    expect(row?.lastError).toContain('Restart the app');
  });

  it('records no warning when the disconnect really did rewrite the file', async () => {
    const { persistSentryConnection, disconnectSentry } = await import(
      '../../lib/integrations/sentry-persist'
    );
    await persistSentryConnection({
      dsn: DSN_A,
      projectId: '111111',
      host: 'o123.ingest.sentry.io',
      environment: 'production',
      limited: true,
    });

    const result = await disconnectSentry();

    expect(result.stillSendingUntilRestart).toBe(false);
    expect(readFile()?.enabled).toBe(false);
    const row = await prisma.integration.findUnique({
      where: { workspaceId_kind: { workspaceId: DEFAULT_WORKSPACE_ID, kind: 'SENTRY' } },
      select: { lastError: true },
    });
    expect(row?.lastError).toBeNull();
  });

  it('does not write the runtime file when the env migration persists through a caller', async () => {
    const { migrateEnvSentry, resetSentryEnvMigrateForTests } = await import(
      '../../lib/observability/migrate-env'
    );
    resetSentryEnvMigrateForTests();
    const created: string[] = [];
    const result = await migrateEnvSentry({
      env: { SENTRY_DSN: DSN_A },
      getExisting: async () => null,
      createMigrated: async (row) => {
        created.push(row.projectId);
      },
    });
    resetSentryEnvMigrateForTests();

    expect(result.migrated).toBe(true);
    expect(created).toEqual(['111111']);
    // The row writer owns the file. A second writer here could only disagree with the row,
    // and pointed at the default DATA_DIR it wrote fixture state into the running app.
    expect(readFile()).toBeNull();
    expect(await readRow()).toBeNull();
  });
});
