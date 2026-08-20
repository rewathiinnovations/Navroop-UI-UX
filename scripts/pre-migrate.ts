/**
 * Production pre-migrate: refuse destructive SQL without a flag, back up first, fail closed.
 *   node ./node_modules/tsx/dist/cli.mjs scripts/pre-migrate.ts
 *
 * Wired from docker-entrypoint.mjs (production start). Skips the backup step when
 * NODE_ENV is not production so local development is not blocked, and skips both the
 * destructive gate and the backup on a database that has no `_prisma_migrations` table
 * yet — a first deploy has nothing to destroy and nothing to dump (F-704).
 */
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { PrismaClient } from '../generated/prisma/index.js';
import { runDbBackup } from '../lib/backup/db.ts';
import {
  assertSafePrismaCommand,
  loadMigrationSql,
  pendingMigrationSql,
  readAppliedMigrations,
  runPreMigrate,
} from '../lib/migrate/safety.ts';

config({ path: resolve(process.cwd(), '.env') });
config({ path: resolve(process.cwd(), '.env.local'), override: true });

assertSafePrismaCommand(process.argv, process.env.NODE_ENV || 'development');

const nodeEnv = process.env.NODE_ENV || 'development';
const allowDestructive = process.env.ALLOW_DESTRUCTIVE_MIGRATION === 'true';
const migrationsDir = resolve(process.cwd(), 'prisma/migrations');

const prisma = new PrismaClient();
// `readAppliedMigrations` reports its own failure instead of throwing, so the disconnect
// needs no try/finally and the result can stay `const`.
const read = await readAppliedMigrations(
  () => prisma.$queryRaw<Array<{ migration_name: string }>>`
    SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL
  `,
);
await prisma.$disconnect();

if (!read.ok) {
  // A missing `_prisma_migrations` is handled as a fresh database, so reaching here means
  // the database itself could not be read.
  console.error('[pre-migrate] could not read applied migrations');
  console.error(read.error);
  if (nodeEnv === 'production') process.exit(1);
}

const applied = read.ok ? read.applied : [];
const freshDatabase = read.ok && read.freshDatabase;

if (freshDatabase) {
  console.log('[pre-migrate] no _prisma_migrations table: first deploy against an empty database');
  console.log('[pre-migrate] nothing to back up; prisma migrate deploy will create the schema');
}

const all = await loadMigrationSql(migrationsDir);
const pendingSql = pendingMigrationSql(all, applied);

const result = await runPreMigrate({
  nodeEnv,
  allowDestructive,
  pendingSql,
  freshDatabase,
  backup: async () => {
    if (pendingSql.length === 0) {
      console.log('[pre-migrate] no pending migrations');
      return { ok: true };
    }
    const backup = await runDbBackup();
    if (!backup.ok) return { ok: false, error: backup.error };
    return { ok: true, objectKey: backup.objectKey, sizeBytes: backup.sizeBytes };
  },
});

if (result.offending?.length) {
  for (const statement of result.offending) {
    console.error(`[pre-migrate] destructive: ${statement}`);
  }
}

if (!result.ok) {
  console.error(`[pre-migrate] ${result.error}`);
  process.exit(result.exitCode);
}

if (result.objectKey) {
  console.log(`[pre-migrate] backup object key: ${result.objectKey}`);
  console.log('[pre-migrate] quote this key for rollback (scripts/restore-db.ts --key …)');
}

console.log('[pre-migrate] ok');
