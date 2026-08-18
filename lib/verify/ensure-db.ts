import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

const SAFE_DB_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type EnsureDatabaseResult = {
  ok: boolean;
  created: boolean;
  skipped?: boolean;
  output: string;
};

function connectionIdentity(adminUrl: string) {
  const parsed = new URL(adminUrl);
  return {
    user: decodeURIComponent(parsed.username || 'openlovable'),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')).split('?')[0] || 'openlovable',
  };
}

function dockerPostgresContainer() {
  const named = process.env.POSTGRES_CONTAINER || 'open-lovable-db';
  const inspect = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', named], { encoding: 'utf8' });
  if (inspect.status === 0 && inspect.stdout.trim() === 'true') return named;

  const list = spawnSync(
    'docker',
    ['ps', '--filter', 'ancestor=postgres:16-alpine', '--format', '{{.Names}}'],
    { encoding: 'utf8' },
  );
  return list.stdout.trim().split(/\r?\n/).find(Boolean) || named;
}

function runPsql(adminUrl: string, sql: string, tupleOnly: boolean): SpawnSyncReturns<string> {
  const hostArgs = tupleOnly ? [adminUrl, '-tc', sql] : [adminUrl, '-c', sql];
  const host = spawnSync('psql', hostArgs, { encoding: 'utf8' });
  if (!(host.error && (host.error as NodeJS.ErrnoException).code === 'ENOENT')) {
    return host;
  }

  const { user, database } = connectionIdentity(adminUrl);
  const container = dockerPostgresContainer();
  const dockerArgs = [
    'exec',
    '-i',
    container,
    'psql',
    '-U',
    user,
    '-d',
    database,
    ...(tupleOnly ? ['-tc', sql] : ['-c', sql]),
  ];
  return spawnSync('docker', dockerArgs, { encoding: 'utf8' });
}

/**
 * Create a Postgres database when missing (same pattern as scripts/ensure-test-db.ts).
 * Uses host `psql`, then `docker exec` into the local/CI Postgres container.
 */
export function ensurePostgresDatabase(options: { adminUrl: string; name: string }): EnsureDatabaseResult {
  if (!SAFE_DB_NAME.test(options.name)) {
    return { ok: false, created: false, output: `Invalid database name: ${options.name}` };
  }

  const exists = runPsql(
    options.adminUrl,
    `SELECT 1 FROM pg_database WHERE datname = '${options.name}'`,
    true,
  );

  if (exists.error && (exists.error as NodeJS.ErrnoException).code === 'ENOENT') {
    return {
      ok: false,
      created: false,
      skipped: true,
      output: 'psql and docker are unavailable; cannot create the shadow database',
    };
  }

  if (exists.status !== 0) {
    return {
      ok: false,
      created: false,
      output: exists.stderr || exists.stdout || 'psql failed. Is docker-compose.dev.yml up?',
    };
  }

  if (exists.stdout.includes('1')) {
    return { ok: true, created: false, output: `Database ${options.name} already exists` };
  }

  const created = runPsql(options.adminUrl, `CREATE DATABASE ${options.name}`, false);
  if (created.status !== 0) {
    return {
      ok: false,
      created: false,
      output: created.stderr || created.stdout || 'CREATE DATABASE failed',
    };
  }

  return { ok: true, created: true, output: `Created database ${options.name}` };
}
