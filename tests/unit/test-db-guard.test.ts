import { readFile } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertTestEnvApplied, testPrismaClient, TEST_DB_SETUP_MISSING } from '../setup/db';
import { DB_SUITES } from '../setup/suites';

/**
 * Every suite under `tests/` documents itself as `Run: npx tsx tests/<name>.test.ts`,
 * and that command never loads `tests/setup/env.ts`. A DB suite run that way would
 * create and delete rows in the application database. `tests/setup/db.ts` refuses to
 * hand out a client until the redirect has happened; this proves it refuses, that it
 * stays quiet on the normal path, and that no DB suite can sidestep it.
 */

const repoRoot = resolve(import.meta.dirname, '..', '..');

/** What a direct `npx tsx` run looks like: the app URL, never overwritten. */
const directRun = {
  DATABASE_URL: 'postgresql://navroop@localhost:5432/navroop',
  TEST_DATABASE_URL: 'postgresql://navroop@localhost:5433/openlovable_test',
} as NodeJS.ProcessEnv;

/** What `tests/setup/env.ts` leaves behind: both names point at the test database. */
const afterSetup = {
  DATABASE_URL: 'postgresql://navroop@localhost:5433/openlovable_test',
  TEST_DATABASE_URL: 'postgresql://navroop@localhost:5433/openlovable_test',
} as NodeJS.ProcessEnv;

describe('test database guard', () => {
  it('refuses when DATABASE_URL was never redirected', () => {
    expect(() => assertTestEnvApplied(directRun)).toThrow(TEST_DB_SETUP_MISSING);
  });

  it('refuses when there is no test database configured', () => {
    expect(() =>
      assertTestEnvApplied({ DATABASE_URL: directRun.DATABASE_URL } as NodeJS.ProcessEnv),
    ).toThrow(TEST_DB_SETUP_MISSING);
    expect(() =>
      assertTestEnvApplied({ ...directRun, TEST_DATABASE_URL: '   ' } as NodeJS.ProcessEnv),
    ).toThrow(TEST_DB_SETUP_MISSING);
  });

  it('names the safe way to run the suite', () => {
    let message = '';
    try {
      assertTestEnvApplied(directRun);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('pnpm exec vitest run tests/integration/legacy-db-suites.test.ts');
    expect(message).toContain('-t search');
  });

  it('never prints a database URL, which carries credentials', () => {
    let message = '';
    try {
      assertTestEnvApplied(directRun);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain('postgresql://');
    expect(message).not.toContain('5432');
  });

  it('stays silent once the redirect has happened', () => {
    expect(assertTestEnvApplied(afterSetup)).toBe(afterSetup.TEST_DATABASE_URL);
  });

  it('is silent for the live vitest environment', () => {
    // The DB suites run in this process shape. If this ever throws, the guard would be
    // failing the normal path rather than the dangerous one.
    const { DATABASE_URL, TEST_DATABASE_URL } = process.env;
    if (!TEST_DATABASE_URL || DATABASE_URL !== TEST_DATABASE_URL) {
      // tests/unit/** does not load tests/setup/env.ts, so this shape is expected here
      // and is exactly what the guard is meant to reject.
      expect(() => assertTestEnvApplied(process.env)).toThrow(TEST_DB_SETUP_MISSING);
      return;
    }
    expect(() => assertTestEnvApplied(process.env)).not.toThrow();
  });

  it('hands back no client at all on a direct run', () => {
    // The whole point: a direct `npx tsx` run must not get as far as holding a client,
    // because a client is the only thing that could open a connection.
    const saved = {
      app: process.env.DATABASE_URL,
      test: process.env.TEST_DATABASE_URL,
    };
    try {
      process.env.DATABASE_URL = directRun.DATABASE_URL;
      process.env.TEST_DATABASE_URL = directRun.TEST_DATABASE_URL;
      expect(() => testPrismaClient()).toThrow(TEST_DB_SETUP_MISSING);
    } finally {
      if (saved.app === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = saved.app;
      if (saved.test === undefined) delete process.env.TEST_DATABASE_URL;
      else process.env.TEST_DATABASE_URL = saved.test;
    }
  });

  it('leaves no DB suite able to build its own client', async () => {
    expect(DB_SUITES.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const [, suitePath] of DB_SUITES) {
      const rel = posix.normalize(posix.join('tests/setup', suitePath));
      const source = await readFile(resolve(repoRoot, rel), 'utf8');
      if (!source.includes('testPrismaClient(') || /new PrismaClient\(/.test(source)) {
        offenders.push(rel);
      }
    }
    expect(
      offenders,
      'A DB suite must get its client from tests/setup/db.ts (testPrismaClient), not construct one, so a direct tsx run cannot reach the application database.',
    ).toEqual([]);
  });
});
