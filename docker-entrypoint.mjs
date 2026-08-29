import { spawn, spawnSync } from 'node:child_process';

function fail(message) {
  console.error(`[navroop] ${message}`);
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  fail(
    'DATABASE_URL must be set. Coolify example: postgresql://navroop:PASSWORD@postgres:5432/navroop',
  );
}

if (!process.env.AUTH_SECRET && !process.env.NEXTAUTH_SECRET) {
  fail('AUTH_SECRET must be set in Coolify (or NEXTAUTH_SECRET).');
}

const appUrl = process.env.APP_URL || process.env.NEXTAUTH_URL || process.env.AUTH_URL;
if (!appUrl) {
  fail('APP_URL must be set (NEXTAUTH_URL / AUTH_URL are accepted aliases).');
}

const encryptionKey = process.env.ENCRYPTION_KEY || '';
if (!encryptionKey || Buffer.byteLength(encryptionKey, 'utf8') < 32) {
  fail(
    encryptionKey
      ? 'ENCRYPTION_KEY is too short (must be at least 32 bytes).'
      : 'ENCRYPTION_KEY is missing (must be at least 32 bytes).',
  );
}

if (!process.env.DEPLOYED_AT) {
  process.env.DEPLOYED_AT = new Date().toISOString();
}

process.env.HOSTNAME = process.env.HOSTNAME || '0.0.0.0';
process.env.PORT = process.env.PORT || '3000';

console.log('[navroop] pre-migrate');
const preMigrate = spawnSync('tsx', ['scripts/pre-migrate.ts'], {
  stdio: 'inherit',
  env: process.env,
});
if (preMigrate.error) {
  fail(`pre-migrate failed to start: ${preMigrate.error.message}`);
}
if (preMigrate.status !== 0) {
  process.exit(preMigrate.status ?? 1);
}

console.log('[navroop] prisma migrate deploy');
const migrate = spawnSync('prisma', ['migrate', 'deploy'], {
  stdio: 'inherit',
  env: process.env,
});

if (migrate.error) {
  fail(`prisma migrate deploy failed to start: ${migrate.error.message}`);
}
if (migrate.status !== 0) {
  process.exit(migrate.status ?? 1);
}

// Plans and built-in templates. A migrated-but-empty database 500s the app's core
// flows — project creation and invites both resolve the workspace plan through
// `getEffectivePlan`, which throws "No default plan is configured" when the Plan
// table is empty — and nothing else in this boot sequence writes rows. The seed is
// the documented one entry point (prisma/seed.ts): idempotent upserts, no network,
// and its admin half no-ops unless SEED_ADMIN_* / ADMIN_* are set, so on a
// populated database this is a fast no-op rather than a second source of data.
// Deliberately non-fatal: on the steady state — an already-populated database —
// this is a no-op, and a seed hiccup must never crash-loop a healthy deployment.
// On a fresh database a failure here leaves the 500s it exists to prevent, so it
// is loud, but the app still boots and an operator can run the seed by hand.
console.log('[navroop] prisma seed (idempotent)');
const seed = spawnSync('tsx', ['prisma/seed.ts'], {
  stdio: 'inherit',
  env: process.env,
});
if (seed.error || seed.status !== 0) {
  console.error(
    `[navroop] prisma seed did not complete (${seed.error ? seed.error.message : `exit ${seed.status}`}); continuing boot — a fresh database will refuse project creation until it is seeded`,
  );
}

console.log('[navroop] job reconcile');
const reconcile = spawnSync('tsx', ['scripts/reconcile-jobs.ts'], {
  stdio: 'inherit',
  env: process.env,
});
if (reconcile.error) {
  fail(`job reconcile failed to start: ${reconcile.error.message}`);
}
if (reconcile.status !== 0) {
  process.exit(reconcile.status ?? 1);
}

const child = spawn('node', ['server.js'], {
  stdio: 'inherit',
  env: process.env,
});

const forward = (signal) => {
  if (!child.killed) child.kill(signal);
};

process.on('SIGTERM', () => forward('SIGTERM'));
process.on('SIGINT', () => forward('SIGINT'));

child.on('exit', (code, signal) => {
  if (signal) {
    process.exit(1);
    return;
  }
  process.exit(code ?? 1);
});
