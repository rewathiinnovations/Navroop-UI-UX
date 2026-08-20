import '../setup/env';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/index.js';
import { assertTestEnvApplied } from '../setup/db';
import {
  isUndefinedTableError,
  readAppliedMigrations,
  UNDEFINED_TABLE,
} from '@/lib/migrate/safety';

/**
 * The error shape `pre-migrate` has to recognise, taken from real Postgres (F-704).
 *
 * `tests/unit/pre-migrate-fresh-db.test.ts` drives `readAppliedMigrations` with a hand-built
 * error. That is the whole risk: if Prisma reports a missing relation differently from the
 * fixture, the fresh-database branch never runs and the first production deploy crash-loops
 * exactly as before, with every unit test green. So this suite makes Postgres produce it.
 *
 * The connection is `TEST_DATABASE_URL` with `?schema=` pointed at a schema that does not
 * exist, so `_prisma_migrations` is genuinely unresolvable while nothing is created, dropped
 * or written anywhere. Deriving the URL from the asserted test URL means it cannot address
 * another database.
 */

const testUrl = new URL(assertTestEnvApplied());
testUrl.searchParams.set('schema', 'navroop_pre_migrate_absent_schema');
const prisma = new PrismaClient({ datasourceUrl: testUrl.toString() });

afterAll(async () => {
  await prisma.$disconnect();
});

describe('pre-migrate against a schema with no migration history', () => {
  it('reads Postgres 42P01 as a fresh database rather than a read failure', async () => {
    const result = await readAppliedMigrations(
      () => prisma.$queryRaw<Array<{ migration_name: string }>>`
        SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL
      `,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.freshDatabase).toBe(true);
    expect(result.applied).toEqual([]);
  });

  it('carries the driver code where isUndefinedTableError looks for it', async () => {
    const error = await prisma.$queryRaw`SELECT migration_name FROM _prisma_migrations`.then(
      () => null,
      (thrown: unknown) => thrown,
    );

    if (!error || typeof error !== 'object') throw new Error('expected a thrown error object');
    // Prisma wraps a raw-query driver error as P2010 and puts the Postgres code in `meta`.
    expect('code' in error ? error.code : null).toBe('P2010');
    const meta = 'meta' in error ? error.meta : null;
    if (!meta || typeof meta !== 'object') throw new Error('expected error.meta');
    expect('code' in meta ? meta.code : null).toBe(UNDEFINED_TABLE);
    expect(isUndefinedTableError(error)).toBe(true);
  });

  it('keeps a reachable database with history on the guarded path', async () => {
    // The test database itself has `_prisma_migrations`, so the same call must not report
    // a fresh database — otherwise the branch would disable the destructive gate everywhere.
    const applied = new PrismaClient();
    try {
      const result = await readAppliedMigrations(
        () => applied.$queryRaw<Array<{ migration_name: string }>>`
          SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL
        `,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.freshDatabase).toBe(false);
      expect(result.applied.length).toBeGreaterThan(0);
    } finally {
      await applied.$disconnect();
    }
  });
});
