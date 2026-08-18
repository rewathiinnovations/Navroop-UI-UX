/**
 * Apply committed migrations to the test database.
 *
 *   pnpm run db:test:migrate
 *
 * `scripts/ensure-test-db.ts` only CREATEs the databases, so a test database
 * that predates a migration stays behind the committed schema forever. Raw SQL
 * in the integration suites is then grammar-checked against tables that do not
 * exist, and the suite passes while proving nothing. This closes that gap.
 *
 * The guard is the point: `prisma migrate deploy` writes to whatever
 * `DATABASE_URL` names, so this script refuses to run unless the target
 * database is called exactly `openlovable_test`. Overriding TEST_DATABASE_URL to
 * the application database cannot make it migrate that database.
 *
 * Never runs `prisma generate` — the query engine is locked by the running dev
 * server on Windows and belongs to the dev-server agent (`single-dev-server.mdc`).
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { config } from 'dotenv';

// A URL exported on the command line wins over `.env.local` for this one
// variable: an operator naming a target explicitly should get that target, and
// the name guard below is what makes honouring it safe.
const shellTestUrl = process.env.TEST_DATABASE_URL?.trim();

config({ path: resolve(process.cwd(), '.env') });
config({ path: resolve(process.cwd(), '.env.local'), override: true });

/** The only database this script is ever allowed to migrate. */
const REQUIRED_DATABASE_NAME = 'openlovable_test';

function databaseName(url: string) {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, '')).split('?')[0];
}

const testUrl = shellTestUrl || process.env.TEST_DATABASE_URL?.trim();
if (!testUrl) {
  console.error(
    `[db:test:migrate] TEST_DATABASE_URL is not set. Point it at ${REQUIRED_DATABASE_NAME} (see .env.example).`,
  );
  process.exit(1);
}

let name: string;
try {
  name = databaseName(testUrl);
} catch {
  console.error('[db:test:migrate] TEST_DATABASE_URL is not a parseable URL.');
  process.exit(1);
}

if (name !== REQUIRED_DATABASE_NAME) {
  console.error(
    `[db:test:migrate] refusing to migrate database "${name}". ` +
      `TEST_DATABASE_URL must name ${REQUIRED_DATABASE_NAME} — this script must never touch the application database.`,
  );
  process.exit(1);
}

const appUrl = process.env.DATABASE_URL?.trim();
if (appUrl) {
  let appName: string | null = null;
  try {
    appName = databaseName(appUrl);
  } catch {
    appName = null;
  }
  if (appName === name) {
    console.error(
      `[db:test:migrate] DATABASE_URL and TEST_DATABASE_URL both name "${name}". Give the test database its own name.`,
    );
    process.exit(1);
  }
}

console.log(`Migrating database ${name}`);

// Run the installed CLI directly rather than through a package-manager shim, so
// nothing can decide to reinstall node_modules mid-run.
const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');

const result = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: testUrl },
});

if (result.error || result.status !== 0) {
  if (result.error) console.error(`[db:test:migrate] ${result.error.message}`);
  process.exit(result.status || 1);
}

console.log(`Database ${name} is up to date with prisma/migrations`);
