import { describe, expect, it, vi } from 'vitest';
import {
  isUndefinedTableError,
  readAppliedMigrations,
  runPreMigrate,
  UNDEFINED_TABLE,
} from '@/lib/migrate/safety';

/**
 * The first production deploy against an empty Postgres (F-704).
 *
 * `scripts/pre-migrate.ts` read `_prisma_migrations` before `prisma migrate deploy` had ever
 * run, and treated the resulting `relation does not exist` as a fatal read failure whenever
 * NODE_ENV was production. `docker-entrypoint.mjs` propagates the exit code, so the container
 * crash-looped on the documented Coolify path with a message that named no fix.
 *
 * The distinction these tests hold is the whole fix: "the table is not there yet" is a fresh
 * database and must proceed; "I cannot reach the database" is still fatal. And a database with
 * no migration history has no schema and no rows, so the destructive-SQL gate and the
 * pre-migration dump — both of which exist to protect *existing* data — must not run.
 *
 * The query is driven through an injected thunk rather than a live connection: the test
 * database created by `pnpm db:test` already has `_prisma_migrations`, so the case under test
 * cannot be reproduced against it without dropping a table out from under the other suites.
 */

/** Prisma wraps a Postgres error from a raw query as P2010 with the driver code in `meta`. */
function prismaRawError(code: string, message: string) {
  return Object.assign(new Error(`\nInvalid \`prisma.$queryRaw()\` invocation:\n\n${message}`), {
    name: 'PrismaClientKnownRequestError',
    code: 'P2010',
    meta: { code, message },
  });
}

function unreachableDatabaseError() {
  return Object.assign(new Error("Can't reach database server at `postgres:5432`"), {
    name: 'PrismaClientInitializationError',
    errorCode: 'P1001',
  });
}

const DROP_COLUMN_SQL = 'ALTER TABLE "Project" DROP COLUMN "stack";';

describe('reading applied migrations on a fresh database', () => {
  it('treats a missing _prisma_migrations table as zero migrations applied', async () => {
    const result = await readAppliedMigrations(async () => {
      throw prismaRawError(UNDEFINED_TABLE, 'relation "_prisma_migrations" does not exist');
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.applied).toEqual([]);
    expect(result.freshDatabase).toBe(true);
  });

  it('recognises the bare driver error shape as well as the Prisma envelope', () => {
    expect(isUndefinedTableError(Object.assign(new Error('boom'), { code: UNDEFINED_TABLE }))).toBe(
      true,
    );
    expect(isUndefinedTableError(new Error('relation "_prisma_migrations" does not exist'))).toBe(
      true,
    );
  });

  it('keeps an unreachable database fatal', async () => {
    const result = await readAppliedMigrations(async () => {
      throw unreachableDatabaseError();
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Can't reach database server");
    expect(isUndefinedTableError(unreachableDatabaseError())).toBe(false);
  });

  it('returns the finished migration names on a database that has history', async () => {
    const result = await readAppliedMigrations(async () => [
      { migration_name: '20260101000000_init' },
      { migration_name: '20260102000000_next' },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.applied).toEqual(['20260101000000_init', '20260102000000_next']);
    expect(result.freshDatabase).toBe(false);
  });
});

describe('pre-migrate on a fresh database', () => {
  it('proceeds without a backup even though every migration is pending', async () => {
    const backup = vi.fn(async () => ({ ok: false, error: 'pg_dump: database is empty' }));

    const result = await runPreMigrate({
      nodeEnv: 'production',
      allowDestructive: false,
      freshDatabase: true,
      // The repo's own history carries a DROP COLUMN and an ALTER COLUMN ... TYPE, so on an
      // empty database the whole set is pending and the destructive gate would refuse it.
      pendingSql: [DROP_COLUMN_SQL],
      backup,
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.freshDatabase).toBe(true);
    expect(result.offending).toBeUndefined();
    expect(backup).not.toHaveBeenCalled();
  });

  it('still refuses destructive SQL on a database that has migration history', async () => {
    const backup = vi.fn(async () => ({ ok: true }));

    const result = await runPreMigrate({
      nodeEnv: 'production',
      allowDestructive: false,
      freshDatabase: false,
      pendingSql: [DROP_COLUMN_SQL],
      backup,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('ALLOW_DESTRUCTIVE_MIGRATION');
    expect(backup).not.toHaveBeenCalled();
  });

  it('still takes a backup on a production database that has migration history', async () => {
    const backup = vi.fn(async () => ({ ok: true, objectKey: 'backups/db/db-1.dump' }));

    const result = await runPreMigrate({
      nodeEnv: 'production',
      allowDestructive: false,
      freshDatabase: false,
      pendingSql: ['ALTER TABLE "Project" ADD COLUMN "note" TEXT;'],
      backup,
    });

    expect(result.ok).toBe(true);
    expect(result.objectKey).toBe('backups/db/db-1.dump');
    expect(backup).toHaveBeenCalledTimes(1);
  });

  it('defaults to the guarded path when the caller does not say', async () => {
    const backup = vi.fn(async () => ({ ok: true }));

    const result = await runPreMigrate({
      nodeEnv: 'production',
      allowDestructive: false,
      pendingSql: [DROP_COLUMN_SQL],
      backup,
    });

    expect(result.ok).toBe(false);
    expect(backup).not.toHaveBeenCalled();
  });
});
