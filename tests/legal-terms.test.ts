/**
 * Terms acceptance for an invited account, and proof that registration is closed.
 *
 * This suite used to drive `registerAccount`, which no longer exists: Navroop has no
 * self-serve registration, so `POST /api/auth/register` refuses everyone without
 * touching the database (see `lib/legal/register.ts` for the incident). The invitee
 * path is what remains: an admin creates the User through `POST /api/admin/invite`, the
 * invitee sets their own password from the emailed single-use link (F-351), and
 * `/api/legal/accept` records their acceptance of the current terms — which is what these
 * assertions cover.
 *
 * A DB suite: run it through the harness, which points DATABASE_URL at
 * TEST_DATABASE_URL before any PrismaClient exists. Running the file directly is refused
 * by `tests/setup/db.ts` on purpose.
 *   pnpm exec vitest run tests/integration/legacy-db-suites.test.ts -t legal-terms
 */
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { testPrismaClient } from './setup/db.ts';
import { TERMS_VERSION, acceptTermsForUser, getTermsStatus } from '../lib/legal/register.ts';
import { POST as registerPOST } from '../app/api/auth/register/route.ts';

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
  // The closed endpoint, checked against the database rather than against its own reply:
  // a refusal that still wrote a row would be the bug worth catching.
  const refused = await registerPOST();
  const refusedBody = (await refused.json()) as { error?: string };
  assert(refused.status === 403, 'POST /api/auth/register answers 403');
  assert(
    refusedBody.error === 'Public signup is disabled. Ask an admin to invite you.',
    'the refusal carries the same copy as /api/auth/signup',
  );
  assert(
    (await prisma.user.count({ where: { email } })) === 0,
    'the closed endpoint creates no user',
  );

  // How an account actually comes into being: the admin invite route creates the User and
  // a pending Invite. This fixture writes the post-acceptance shape directly, since terms
  // acceptance is what is under test here, not the invite mechanics.
  // `Invite.invitedById` is a real FK, so the inviter is a throwaway ADMIN.
  const inviter = await prisma.user.create({
    data: {
      email: `inviter-${suffix}@example.com`,
      name: 'Inviter',
      role: 'ADMIN',
      passwordHash: 'not-a-real-hash',
    },
    select: { id: true },
  });
  createdIds.push(inviter.id);

  const invitee = await prisma.user.create({
    data: { email, name: 'Terms User', role: 'MEMBER', passwordHash: 'not-a-real-hash' },
    select: { id: true },
  });
  createdIds.push(invitee.id);
  await prisma.invite.create({
    data: { email, role: 'MEMBER', invitedById: inviter.id, acceptedAt: new Date() },
  });

  const before = await getTermsStatus(invitee.id);
  assert(
    before.termsAcceptedAt === null && before.termsVersion === null,
    'a freshly invited user has accepted nothing',
  );
  assert(before.currentVersion === TERMS_VERSION, 'the status reports the current version');

  const accepted = await acceptTermsForUser(invitee.id);
  assert(accepted.termsVersion === TERMS_VERSION, 'acceptance records the current version');

  const rows = await prisma.$queryRaw<
    Array<{ termsAcceptedAt: Date | null; termsVersion: string | null }>
  >`
    SELECT "termsAcceptedAt", "termsVersion" FROM "User" WHERE email = ${email}
  `;
  const row = rows[0];
  assert(Boolean(row?.termsAcceptedAt), 'termsAcceptedAt is stored');
  assert(row?.termsVersion === TERMS_VERSION, 'termsVersion is stored');
  assert(
    row?.termsAcceptedAt instanceof Date && row.termsAcceptedAt.getTime() <= Date.now(),
    'acceptance timestamp is a real Date',
  );

  const after = await getTermsStatus(invitee.id);
  assert(
    after.termsAcceptedAt instanceof Date && after.termsVersion === TERMS_VERSION,
    'the status endpoint reads back what was written',
  );

  // A terms bump re-prompts a user who already accepted an older version. Backdated by
  // hand rather than by sleeping, so the "did the second acceptance actually overwrite"
  // question does not depend on the wall clock ticking between two fast statements.
  const stale = new Date('2020-01-01T00:00:00.000Z');
  await prisma.$executeRaw`
    UPDATE "User"
    SET "termsAcceptedAt" = ${stale}, "termsVersion" = '2019-01-01'
    WHERE id = ${invitee.id}
  `;
  const outdated = await getTermsStatus(invitee.id);
  assert(
    outdated.termsVersion === '2019-01-01' && outdated.currentVersion === TERMS_VERSION,
    'a stale acceptance is reported as stale, which is what re-prompts',
  );

  await acceptTermsForUser(invitee.id);
  const reaccepted = await getTermsStatus(invitee.id);
  assert(
    reaccepted.termsVersion === TERMS_VERSION &&
      reaccepted.termsAcceptedAt instanceof Date &&
      reaccepted.termsAcceptedAt.getTime() > stale.getTime(),
    'accepting the new version overwrites the stale acceptance',
  );

  // The shape `/api/legal/accept` GET depends on when the session user has since been
  // deleted: nulls, never a throw and never a missing currentVersion.
  const unknown = await getTermsStatus('user_does_not_exist');
  assert(
    unknown.termsAcceptedAt === null &&
      unknown.termsVersion === null &&
      unknown.currentVersion === TERMS_VERSION,
    'an unknown user id yields nulls plus the current version',
  );
} finally {
  await prisma.invite.deleteMany({ where: { email } });
  if (createdIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdIds } } });
  }
  await prisma.$disconnect();
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
