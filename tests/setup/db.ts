import { PrismaClient } from '../../generated/prisma/index.js';

/**
 * The only way a suite in this repo should obtain a Prisma client.
 *
 * Each suite under `tests/` carries a `Run: pnpm exec tsx tests/<name>.test.ts` header, and
 * that command does not load `tests/setup/env.ts`. Without it, `DATABASE_URL` is still
 * the application database, so a suite that creates and deletes users, projects and
 * jobs would do it to real data. A comment cannot prevent that; refusing to hand out a
 * client can.
 *
 * `tests/setup/env.ts` runs `applyTestDatabaseUrl`, which validates the pair with
 * `assertTestDatabaseUrl` and then overwrites `DATABASE_URL` with `TEST_DATABASE_URL`.
 * This guard sits in front of that and only checks whether it happened — it does not
 * repeat or relax those checks.
 */

export const TEST_DB_SETUP_MISSING =
  'Refusing to open a database connection: DATABASE_URL has not been redirected to the test database.';

function runThroughVitest(detail: string) {
  return [
    TEST_DB_SETUP_MISSING,
    '',
    detail,
    '',
    'This suite writes and deletes rows, so running it against the application database',
    'would destroy real data. Run it through Vitest, which loads tests/setup/env.ts',
    'first and points DATABASE_URL at TEST_DATABASE_URL:',
    '',
    '  pnpm exec vitest run tests/integration/legacy-db-suites.test.ts',
    '',
    'To run one suite, add -t and its registered name from tests/setup/suites.ts:',
    '',
    '  pnpm exec vitest run tests/integration/legacy-db-suites.test.ts -t search',
  ].join('\n');
}

/**
 * Throws unless `tests/setup/env.ts` has already redirected `DATABASE_URL`.
 *
 * Exported separately from the client factory so it can be asserted directly, without
 * constructing anything.
 */
export function assertTestEnvApplied(env: NodeJS.ProcessEnv = process.env) {
  const testUrl = env.TEST_DATABASE_URL?.trim();
  if (!testUrl) {
    throw new Error(
      runThroughVitest('TEST_DATABASE_URL is not set, so there is no test database to use.'),
    );
  }
  const appUrl = env.DATABASE_URL?.trim();
  if (appUrl !== testUrl) {
    // Deliberately does not print either URL: they carry credentials.
    throw new Error(
      runThroughVitest('DATABASE_URL still points somewhere other than TEST_DATABASE_URL.'),
    );
  }
  return testUrl;
}

/**
 * A Prisma client for the test database. Asserts first, so a direct `pnpm exec tsx` run
 * throws here rather than at the first query — nothing connects, and no data is touched.
 */
export function testPrismaClient() {
  assertTestEnvApplied();
  return new PrismaClient();
}
