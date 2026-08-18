/**
 * /api/health with injected db + storage.
 * Run: pnpm exec tsx tests/health.test.ts
 */
import { runHealthChecks } from '../lib/health/check.ts';

let failed = 0;
let passed = 0;

function assert(cond: unknown, name: string) {
  if (cond) {
    passed += 1;
    console.log(`PASS  ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL  ${name}`);
}

const okDb = {
  async $queryRaw() {
    return [{ ok: 1 }];
  },
};
const deadDb = {
  async $queryRaw() {
    throw new Error('connect ECONNREFUSED');
  },
};

const healthy = await runHealthChecks({
  db: okDb,
  storageHead: async () => true,
  now: 1_000,
  startedAt: 0,
  version: '0.1.0',
});
assert(healthy.ok === true, 'ok true when db and storage pass');
assert(healthy.checks.db === 'ok', 'db check ok');
assert(healthy.checks.storage === 'ok', 'storage check ok');
assert(healthy.version === '0.1.0', 'version present');
assert(typeof healthy.uptime === 'number', 'uptime present');
assert(!('DATABASE_URL' in healthy), 'no DATABASE_URL leak');
assert(!JSON.stringify(healthy).includes('password'), 'no password leak');

const down = await runHealthChecks({
  db: deadDb,
  storageHead: async () => true,
  now: 1_000,
  startedAt: 0,
  version: '0.1.0',
});
assert(down.ok === false, 'ok false when DB unreachable');
assert(down.checks.db === 'fail', 'db check fail');
assert(down.checks.storage === 'ok', 'storage still ok');

const storageDown = await runHealthChecks({
  db: okDb,
  storageHead: async () => {
    throw new Error('HEAD failed');
  },
  now: 1_000,
  startedAt: 0,
  version: '0.1.0',
});
assert(storageDown.ok === false, 'ok false when storage HEAD fails');
assert(storageDown.checks.storage === 'fail', 'storage check fail');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
