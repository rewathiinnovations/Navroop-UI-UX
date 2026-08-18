/**
 * Production pre-migrate: refuse destructive SQL without a flag, back up first, fail closed.
 *   npx tsx scripts/pre-migrate.ts
 *
 * Wired from docker-entrypoint.mjs (production start). Skips the backup step when
 * NODE_ENV is not production so local development is not blocked.
 */
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { PrismaClient } from '../generated/prisma/index.js';
import { runDbBackup } from '../lib/backup/db.ts';
import {
  assertSafePrismaCommand,
  loadMigrationSql,
  pendingMigrationSql,
  runPreMigrate,
} from '../lib/migrate/safety.ts';

config({ path: resolve(process.cwd(), '.env') });
config({ path: resolve(process.cwd(), '.env.local'), override: true });

assertSafePrismaCommand(process.argv, process.env.NODE_ENV || 'development');

const nodeEnv = process.env.NODE_ENV || 'development';
const allowDestructive = process.env.ALLOW_DESTRUCTIVE_MIGRATION === 'true';
const migrationsDir = resolve(process.cwd(), 'prisma/migrations');

const prisma = new PrismaClient();

let applied: string[] = [];
try {
  const rows = await prisma.$queryRaw<Array<{ migration_name: string }>>`
    SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL
  `;
  applied = rows.map((row) => row.migration_name);
} catch (error) {
  if (nodeEnv === 'production') {
    console.error('[pre-migrate] could not read applied migrations');
    console.error(error instanceof Error ? error.message : error);
    await prisma.$disconnect();
    process.exit(1);
  }
} finally {
  await prisma.$disconnect();
}

const all = await loadMigrationSql(migrationsDir);
const pendingSql = pendingMigrationSql(all, applied);

const result = await runPreMigrate({
  nodeEnv,
  allowDestructive,
  pendingSql,
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
