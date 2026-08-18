/**
 * Terms acceptance is required on register and the timestamp is stored.
 * Run: npx tsx tests/legal-terms.test.ts
 */
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { testPrismaClient } from './setup/db.ts';
import { TERMS_VERSION, registerAccount } from '../lib/legal/register.ts';

config({ path: resolve(process.cwd(), '.env.local') });
config({ path: resolve(process.cwd(), '.env') });

const prisma = testPrismaClient();

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

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
const email = `terms-${suffix}@example.com`;
const createdIds: string[] = [];

try {
  const refused = await registerAccount({
    name: 'Terms User',
    email,
    password: 'TermsPass123',
    acceptTerms: false,
  });
  assert(refused.ok === false && refused.status === 400, 'register without terms checkbox is rejected');

  const missing = await registerAccount({
    name: 'Terms User',
    email,
    password: 'TermsPass123',
  });
  assert(missing.ok === false && missing.status === 400, 'register without acceptTerms is rejected');

  const created = await registerAccount({
    name: 'Terms User',
    email,
    password: 'TermsPass123',
    acceptTerms: true,
  });
  assert(created.ok === true, 'register with terms checkbox succeeds');
  if (created.ok) createdIds.push(created.user.id);

  const rows = await prisma.$queryRaw<Array<{ termsAcceptedAt: Date | null; termsVersion: string | null }>>`
    SELECT "termsAcceptedAt", "termsVersion" FROM "User" WHERE email = ${email}
  `;
  const row = rows[0];
  assert(Boolean(row?.termsAcceptedAt), 'termsAcceptedAt is stored');
  assert(row?.termsVersion === TERMS_VERSION, 'termsVersion is stored');
  assert(
    row?.termsAcceptedAt instanceof Date && row.termsAcceptedAt.getTime() <= Date.now(),
    'acceptance timestamp is a real Date',
  );
} finally {
  if (createdIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdIds } } });
  }
  await prisma.$disconnect();
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
