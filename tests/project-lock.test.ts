/**
 * Project lock: atomic acquire, expiry reuse, renew, release, admin forceRelease.
 * Run: pnpm exec tsx tests/project-lock.test.ts
 */
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { testPrismaClient } from './setup/db.ts';
import { hashPassword } from '../lib/password.ts';
import {
  acquireLock,
  forceRelease,
  releaseLock,
  renewLock,
} from '../lib/projects/lock.ts';

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
const ownerEmail = `lock-owner-${suffix}@example.com`;
const otherEmail = `lock-other-${suffix}@example.com`;
const adminEmail = `lock-admin-${suffix}@example.com`;

try {
  const passwordHash = await hashPassword('LockTest123');
  const owner = await prisma.user.create({
    data: { email: ownerEmail, name: 'Lock Owner', passwordHash, role: 'MEMBER' },
  });
  const other = await prisma.user.create({
    data: { email: otherEmail, name: 'Lock Other', passwordHash, role: 'MEMBER' },
  });
  const admin = await prisma.user.create({
    data: { email: adminEmail, name: 'Lock Admin', passwordHash, role: 'ADMIN' },
  });

  const project = await prisma.project.create({
    data: {
      name: `Lock test ${suffix}`,
      initialPrompt: 'lock test',
      ownerId: owner.id,
    },
  });

  const [first, second] = await Promise.all([
    acquireLock(project.id, owner.id, 'generation'),
    acquireLock(project.id, other.id, 'generation'),
  ]);
  const wins = [first, second].filter((row) => row.ok);
  const losses = [first, second].filter((row) => !row.ok);
  assert(wins.length === 1, 'atomic acquire: exactly one caller wins');
  assert(losses.length === 1, 'atomic acquire: exactly one caller loses');
  const held = losses[0];
  if (!held.ok) {
    const holderIsOneOfThem = held.heldBy.id === owner.id || held.heldBy.id === other.id;
    assert(holderIsOneOfThem, 'atomic acquire: heldBy is one of the two callers');
    assert(held.heldBy.name === 'Lock Owner' || held.heldBy.name === 'Lock Other', 'atomic acquire: loser names the holder');
    assert(held.expiresAt instanceof Date, 'atomic acquire: loser gets expiresAt');
  }

  const winnerId = first.ok ? owner.id : other.id;
  const loserId = first.ok ? other.id : owner.id;

  await prisma.$executeRaw`
    UPDATE "Project"
    SET "lockExpiresAt" = NOW() - INTERVAL '1 minute'
    WHERE id = ${project.id}
  `;
  const reuse = await acquireLock(project.id, loserId, 'publish');
  assert(reuse.ok === true, 'expired lock can be taken by another user');

  const renewedBefore = await prisma.$queryRaw<Array<{ lockExpiresAt: Date }>>`
    SELECT "lockExpiresAt" FROM "Project" WHERE id = ${project.id}
  `;
  await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  const renewed = await renewLock(project.id, loserId);
  assert(renewed.ok === true, 'holder can renew their lock');
  const renewedAfter = await prisma.$queryRaw<Array<{ lockExpiresAt: Date }>>`
    SELECT "lockExpiresAt" FROM "Project" WHERE id = ${project.id}
  `;
  assert(
    renewedAfter[0].lockExpiresAt.getTime() > renewedBefore[0].lockExpiresAt.getTime(),
    'renew extends lockExpiresAt',
  );

  const strangerRenew = await renewLock(project.id, winnerId);
  assert(strangerRenew.ok === false, 'non-holder cannot renew');

  const released = await releaseLock(project.id, loserId);
  assert(released.ok === true, 'holder can release');
  const afterRelease = await acquireLock(project.id, owner.id, 'import');
  assert(afterRelease.ok === true, 'project is free after release');

  const memberForce = await forceRelease(project.id, other.id);
  assert(memberForce.ok === false, 'forceRelease is admin-only for members');

  const adminForce = await forceRelease(project.id, admin.id);
  assert(adminForce.ok === true, 'admin can forceRelease a held lock');
  const afterForce = await acquireLock(project.id, other.id, 'audit');
  assert(afterForce.ok === true, 'project is free after admin forceRelease');

  await releaseLock(project.id, other.id);
  await prisma.project.delete({ where: { id: project.id } });
  await prisma.user.deleteMany({ where: { id: { in: [owner.id, other.id, admin.id] } } });
} catch (error) {
  failed += 1;
  console.error('FAIL  project-lock suite threw');
  console.error(error);
} finally {
  await prisma.$disconnect();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
