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
};

export type PreMigrateResult = {
  ok: boolean;
  exitCode: number;
  error?: string;
  objectKey?: string;
  offending?: string[];
};

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
