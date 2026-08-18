import '../setup/env';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { testPrismaClient } from '../setup/db';
import { consumeGithubCsrf, createGithubCsrf } from '@/lib/integrations/csrf';

/**
 * End to end against Postgres: the same `state` must never be accepted twice, and the row must
 * be gone the moment it is accepted. The delete is now conditional on the value that was read,
 * so exactly one caller can win a race.
 */

const prisma = testPrismaClient();
const KEY = 'integration.github.csrf';

beforeEach(async () => {
  await prisma.appSetting.deleteMany({ where: { key: KEY } });
});

afterAll(async () => {
  await prisma.appSetting.deleteMany({ where: { key: KEY } });
  await prisma.$disconnect();
});

describe('github oauth state is single use', () => {
  it('accepts a state once and consumes the row', async () => {
    const created = await createGithubCsrf('acme', 'user_1');

    const payload = await consumeGithubCsrf(created.state);
    expect(payload?.org).toBe('acme');
    expect(payload?.userId).toBe('user_1');
    expect(await prisma.appSetting.findUnique({ where: { key: KEY } })).toBeNull();
  });

  it('refuses a replay of the same state inside the TTL', async () => {
    const created = await createGithubCsrf('acme', 'user_1');
    await consumeGithubCsrf(created.state);

    // The replay window the old code left open when the delete failed.
    expect(await consumeGithubCsrf(created.state)).toBeNull();
  });

  it('refuses a state that does not match the stored row and leaves the row intact', async () => {
    await createGithubCsrf('acme', 'user_1');

    expect(await consumeGithubCsrf('not-the-state')).toBeNull();
    expect(await prisma.appSetting.findUnique({ where: { key: KEY } })).not.toBeNull();
  });

  it('lets only one of two concurrent consumers win', async () => {
    const created = await createGithubCsrf('acme', 'user_1');

    const [a, b] = await Promise.all([
      consumeGithubCsrf(created.state),
      consumeGithubCsrf(created.state),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
  });
});
