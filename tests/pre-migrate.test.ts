/**
 * Migration safety: destructive SQL gate, production backup fail-closed,
 * refuse prisma db push / migrate reset outside development.
 * Run: pnpm exec tsx tests/pre-migrate.test.ts
 */
import {
  assertSafePrismaCommand,
  findDestructiveStatements,
  runPreMigrate,
} from '../lib/migrate/safety.ts';

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

const dropColumnSql = `
ALTER TABLE "Workspace" DROP COLUMN "creditsUsed";
ALTER TABLE "Plan" ADD COLUMN "note" TEXT;
`;

const destructive = findDestructiveStatements(dropColumnSql);
assert(destructive.length >= 1, 'DROP COLUMN is detected as destructive');
assert(
  destructive.some((row) => /DROP COLUMN/i.test(row)),
  'offending DROP COLUMN statement is printed',
);

const typeChange = findDestructiveStatements(
  'ALTER TABLE "User" ALTER COLUMN "email" TYPE varchar(80);',
);
assert(typeChange.length >= 1, 'ALTER COLUMN ... TYPE is detected as destructive');

const dropTable = findDestructiveStatements('DROP TABLE "AuditLog";');
assert(dropTable.length >= 1, 'DROP TABLE is detected as destructive');

const safe = findDestructiveStatements('ALTER TABLE "User" ADD COLUMN "note" TEXT;');
assert(safe.length === 0, 'ADD COLUMN is not destructive');

const refused = await runPreMigrate({
  nodeEnv: 'production',
  allowDestructive: false,
  pendingSql: [dropColumnSql],
  backup: async () => ({ ok: true, objectKey: 'backups/db/unused.dump' }),
});
assert(refused.ok === false, 'DROP COLUMN refuses without ALLOW_DESTRUCTIVE_MIGRATION');
assert(
  /DROP COLUMN/i.test(`${refused.error || ''} ${(refused.offending || []).join(' ')}`),
  'refused run prints the DROP COLUMN statement',
);
assert(
  /ALLOW_DESTRUCTIVE_MIGRATION/i.test(refused.error || ''),
  'refused run names the ALLOW_DESTRUCTIVE_MIGRATION flag',
);

const allowed = await runPreMigrate({
  nodeEnv: 'production',
  allowDestructive: true,
  pendingSql: [dropColumnSql],
  backup: async () => ({ ok: true, objectKey: 'backups/db/ok.dump', sizeBytes: 12 }),
});
assert(allowed.ok === true, 'destructive SQL is allowed when the flag is true');

const backupFailed = await runPreMigrate({
  nodeEnv: 'production',
  allowDestructive: false,
  pendingSql: ['ALTER TABLE "User" ADD COLUMN "note" TEXT;'],
  backup: async () => ({ ok: false, error: 'upload failed' }),
});
assert(backupFailed.ok === false, 'production pre-migrate fails closed when backup cannot be uploaded');
assert(backupFailed.exitCode === 1, 'failed production pre-migrate exits non-zero');

const devBackupFailed = await runPreMigrate({
  nodeEnv: 'development',
  allowDestructive: false,
  pendingSql: ['ALTER TABLE "User" ADD COLUMN "note" TEXT;'],
  backup: async () => ({ ok: false, error: 'upload failed' }),
});
assert(devBackupFailed.ok === true, 'development pre-migrate does not fail closed on backup');

const produced = await runPreMigrate({
  nodeEnv: 'production',
  allowDestructive: false,
  pendingSql: ['ALTER TABLE "User" ADD COLUMN "note" TEXT;'],
  backup: async () => ({ ok: true, objectKey: 'backups/db/db-2026-08-17-aaaa.dump', sizeBytes: 99 }),
});
assert(produced.ok === true, 'successful production backup continues');
assert(
  produced.objectKey === 'backups/db/db-2026-08-17-aaaa.dump',
  'prints backup object key for rollback',
);

function commandThrows(argv: string[], nodeEnv: string, name: string) {
  try {
    assertSafePrismaCommand(argv, nodeEnv);
    failed += 1;
    console.error(`FAIL  ${name} (did not throw)`);
  } catch {
    passed += 1;
    console.log(`PASS  ${name}`);
  }
}

function commandOk(argv: string[], nodeEnv: string, name: string) {
  try {
    assertSafePrismaCommand(argv, nodeEnv);
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${name}`, error);
  }
}

commandThrows(['prisma', 'db', 'push'], 'production', 'production refuses prisma db push');
commandThrows(['prisma', 'migrate', 'reset'], 'production', 'production refuses prisma migrate reset');
commandOk(['prisma', 'migrate', 'deploy'], 'production', 'production allows prisma migrate deploy');
commandOk(['prisma', 'db', 'push'], 'development', 'development allows prisma db push');

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
