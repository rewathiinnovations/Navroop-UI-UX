import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type BackupResult = {
  ok: boolean;
  objectKey?: string;
  sizeBytes?: number;
  error?: string;
};

export type PreMigrateInput = {
  nodeEnv: string;
  allowDestructive: boolean;
  pendingSql: string[];
  backup: () => Promise<BackupResult>;
  /**
   * True only when `_prisma_migrations` does not exist — see `readAppliedMigrations`.
   * Defaults to the guarded path, so a caller that cannot tell gets the full gate.
   */
  freshDatabase?: boolean;
};

export type PreMigrateResult = {
  ok: boolean;
  exitCode: number;
  error?: string;
  objectKey?: string;
  offending?: string[];
  /** Echoed so the caller can say *why* it skipped the destructive gate and the dump. */
  freshDatabase?: boolean;
};

/** Postgres `undefined_table`. On a first deploy `_prisma_migrations` is not there yet. */
export const UNDEFINED_TABLE = '42P01';

export type AppliedMigrations =
  { ok: true; applied: string[]; freshDatabase: boolean } | { ok: false; error: string };

/**
 * "The table is not there yet" versus "I cannot reach the database".
 *
 * Prisma wraps a driver error from a raw query as `P2010` and puts the Postgres code in
 * `meta.code`; a bare driver error carries it on `code`. The message check is the last
 * resort for a driver that surfaces neither, and it names the relation so an unrelated
 * missing table can never be read as an empty database.
 */
export function isUndefinedTableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { code?: unknown; meta?: { code?: unknown }; message?: unknown };
  if (record.code === UNDEFINED_TABLE) return true;
  if (record.meta?.code === UNDEFINED_TABLE) return true;
  const message = typeof record.message === 'string' ? record.message : '';
  return /relation "?_prisma_migrations"? does not exist/i.test(message);
}

/**
 * The applied-migration names, or a fresh database, or a hard failure.
 *
 * The query is injected so the caller owns the client and its disconnect, and so the
 * fresh-database branch is testable without dropping `_prisma_migrations` out from under
 * every other suite that shares the test database.
 */
export async function readAppliedMigrations(
  query: () => Promise<Array<{ migration_name: string }>>,
): Promise<AppliedMigrations> {
  try {
    const rows = await query();
    return { ok: true, applied: rows.map((row) => row.migration_name), freshDatabase: false };
  } catch (error) {
    if (isUndefinedTableError(error)) {
      // Nothing has been applied yet. `prisma migrate deploy` creates the table itself.
      return { ok: true, applied: [], freshDatabase: true };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * A migration may declare that its destructive statements were reviewed. This
 * does NOT relax the deploy-time gate — `preMigrate` still demands
 * ALLOW_DESTRUCTIVE_MIGRATION and a backup. It only lets such a migration live
 * in the tree, so the repo policy is "annotated and reviewed", not "never".
 */
export const REVIEWED_DESTRUCTIVE_MARKER = 'navroop:reviewed-destructive';

export function hasReviewedDestructiveMarker(sql: string): boolean {
  return sql.includes(REVIEWED_DESTRUCTIVE_MARKER);
}

export function findDestructiveStatements(sql: string): string[] {
  const text = sql.replace(/--[^\n]*/g, '');
  return text
    .split(';')
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((statement) => {
      if (!statement) return false;
      return (
        /\bDROP\s+TABLE\b/i.test(statement) ||
        /\bDROP\s+COLUMN\b/i.test(statement) ||
        /\bALTER\s+COLUMN\b[\s\S]*\bTYPE\b/i.test(statement)
      );
    });
}

export function assertSafePrismaCommand(argv: string[], nodeEnv: string) {
  if (nodeEnv === 'development' || nodeEnv === 'test') return;
  const joined = argv.join(' ');
  if (/\bdb\s+push\b/.test(joined) || /\bmigrate\s+reset\b/.test(joined)) {
    throw new Error('prisma db push and prisma migrate reset are not allowed outside development');
  }
}

export async function runPreMigrate(input: PreMigrateInput): Promise<PreMigrateResult> {
  // A database with no `_prisma_migrations` table has no schema and no rows. Both gates below
  // protect *existing* data: a DROP COLUMN in a migration that runs against a database it is
  // itself creating cannot lose anything, and `pg_dump` of an empty database captures nothing
  // worth quoting for a rollback. Running them anyway is what made the first production deploy
  // crash-loop (F-704). This flag is set only by `readAppliedMigrations` on a 42P01 — a
  // database that has the table stays fully gated even if it has zero finished rows.
  if (input.freshDatabase) {
    return { ok: true, exitCode: 0, freshDatabase: true };
  }

  const offending = input.pendingSql.flatMap((sql) => findDestructiveStatements(sql));
  if (offending.length > 0 && !input.allowDestructive) {
    return {
      ok: false,
      exitCode: 1,
      error:
        'Destructive migration requires ALLOW_DESTRUCTIVE_MIGRATION=true. Offending statements printed below.',
      offending,
    };
  }

  if (input.nodeEnv !== 'production') {
    return { ok: true, exitCode: 0 };
  }

  const backup = await input.backup();
  if (!backup.ok) {
    return {
      ok: false,
      exitCode: 1,
      error: backup.error || 'Pre-migration backup failed',
    };
  }

  return { ok: true, exitCode: 0, objectKey: backup.objectKey };
}

export async function loadMigrationSql(migrationsDir: string) {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  const rows: Array<{ name: string; sql: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Fail closed. Swallowing a read error dropped the migration from the list, so
    // the DROP TABLE / DROP COLUMN / ALTER TYPE detector reported "no destructive
    // changes" for SQL it never read, and `prisma migrate deploy` applied it anyway.
    const path = join(migrationsDir, entry.name, 'migration.sql');
    let sql: string;
    try {
      sql = await readFile(path, 'utf8');
    } catch (error) {
      throw new Error(
        `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}. ` +
          'Refusing to run the destructive-migration check on an incomplete migration set.',
      );
    }
    if (sql) rows.push({ name: entry.name, sql });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export function pendingMigrationSql(
  all: Array<{ name: string; sql: string }>,
  appliedNames: string[],
) {
  const applied = new Set(appliedNames);
  return all.filter((row) => !applied.has(row.name)).map((row) => row.sql);
}
