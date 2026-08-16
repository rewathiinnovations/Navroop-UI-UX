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

process.env.HOSTNAME = process.env.HOSTNAME || '0.0.0.0';
process.env.PORT = process.env.PORT || '3000';

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
