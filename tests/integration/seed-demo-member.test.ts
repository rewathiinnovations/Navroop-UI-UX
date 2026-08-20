/**
 * F-301: the seed must not create `member@navroop.local` — whose password is a
 * committed literal — in a production database unless the operator says so
 * explicitly with SEED_DEMO_MEMBER=1. Driven against the real test database:
 * these assert on rows, not on console output.
 */
import '../setup/env';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/index.js';
import { DEMO_MEMBER_EMAIL } from '../../lib/ensure-member';
import { demoMemberAllowed, ensureMember } from '../../prisma/seed-users';

const prisma = new PrismaClient();

async function deleteDemoMember() {
  await prisma.user.deleteMany({ where: { email: DEMO_MEMBER_EMAIL } });
}

describe('seed demo-member guard', () => {
  beforeEach(deleteDemoMember);
  afterAll(async () => {
    await deleteDemoMember();
    await prisma.$disconnect();
  });

  it('is refused in production without the explicit flag', () => {
    expect(demoMemberAllowed({ NODE_ENV: 'production' })).toBe(false);
    expect(demoMemberAllowed({ NODE_ENV: 'production', SEED_DEMO_MEMBER: '1' })).toBe(true);
    expect(demoMemberAllowed({ NODE_ENV: 'development' })).toBe(true);
    // Only the exact opt-in counts — truthy lookalikes stay refused.
    expect(demoMemberAllowed({ NODE_ENV: 'production', SEED_DEMO_MEMBER: 'yes' })).toBe(false);
  });

  it('creates no row when NODE_ENV is production', async () => {
    await ensureMember(prisma, { NODE_ENV: 'production' });
    expect(await prisma.user.findUnique({ where: { email: DEMO_MEMBER_EMAIL } })).toBeNull();
  });

  it('creates the member when production explicitly opts in', async () => {
    await ensureMember(prisma, { NODE_ENV: 'production', SEED_DEMO_MEMBER: '1' });
    const row = await prisma.user.findUnique({ where: { email: DEMO_MEMBER_EMAIL } });
    expect(row).toMatchObject({ role: 'MEMBER', email: DEMO_MEMBER_EMAIL });
  });
});
