import '../setup/env';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { testPrismaClient } from '../setup/db';
import { consumeGithubCsrf, createGithubCsrf } from '@/lib/integrations/csrf';

/**
 * End to end against Postgres: the same `state` must never be accepted twice, and the row must
 * be gone the moment it is accepted. The delete is conditional on the value that was read, so
 * exactly one caller can win a race.
 *
 * The row is now keyed by the state value rather than being one global
 * `integration.github.csrf` row (F-242), so two flows in flight are independent — and a
 * refusal says which of unknown / expired / consumed happened.
 */

const prisma = testPrismaClient();
const PREFIX = 'integration.github.csrf';

async function rowCount() {
  return prisma.appSetting.count({ where: { key: { startsWith: `${PREFIX}:` } } });
}

beforeEach(async () => {
  await prisma.appSetting.deleteMany({ where: { key: { startsWith: PREFIX } } });
});

afterAll(async () => {
  await prisma.appSetting.deleteMany({ where: { key: { startsWith: PREFIX } } });
  await prisma.$disconnect();
});

describe('github oauth state is single use', () => {
  it('accepts a state once and consumes the row', async () => {
    const created = await createGithubCsrf('acme', 'user_1');

    const consumed = await consumeGithubCsrf(created.state);

    expect(consumed.ok).toBe(true);
    if (consumed.ok) {
      expect(consumed.payload.org).toBe('acme');
      expect(consumed.payload.userId).toBe('user_1');
    }
    expect(await rowCount()).toBe(0);
  });

  it('refuses a replay of the same state inside the TTL', async () => {
    const created = await createGithubCsrf('acme', 'user_1');
    await consumeGithubCsrf(created.state);

    // The replay window the old code left open when the delete failed.
    const replay = await consumeGithubCsrf(created.state);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe('unknown');
  });

  it('refuses a state we never issued and leaves the stored flow intact', async () => {
    await createGithubCsrf('acme', 'user_1');

    const refused = await consumeGithubCsrf('not-the-state');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe('unknown');
    expect(await rowCount()).toBe(1);
  });

  it('refuses a missing state without touching the store', async () => {
    await createGithubCsrf('acme', 'user_1');

    const refused = await consumeGithubCsrf(null);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe('missing');
    expect(await rowCount()).toBe(1);
  });

  it('lets only one of two concurrent consumers win', async () => {
    const created = await createGithubCsrf('acme', 'user_1');

    const [a, b] = await Promise.all([
      consumeGithubCsrf(created.state),
      consumeGithubCsrf(created.state),
    ]);

    expect([a, b].filter((row) => row.ok)).toHaveLength(1);
  });

  it('keeps two concurrent flows independent', async () => {
    // The whole point of F-242: starting a second connect used to overwrite the first admin's
    // nonce, so their callback failed state validation for no reason they could see.
    const first = await createGithubCsrf('acme', 'user_1');
    const second = await createGithubCsrf('other', 'user_2');

    expect(await rowCount()).toBe(2);

    const firstConsumed = await consumeGithubCsrf(first.state);
    const secondConsumed = await consumeGithubCsrf(second.state);

    expect(firstConsumed.ok).toBe(true);
    expect(secondConsumed.ok).toBe(true);
    if (firstConsumed.ok) expect(firstConsumed.payload.userId).toBe('user_1');
    if (secondConsumed.ok) expect(secondConsumed.payload.userId).toBe('user_2');
    expect(await rowCount()).toBe(0);
  });

  it('prunes an expired flow on the next create instead of accumulating rows', async () => {
    const stale = await createGithubCsrf('acme', 'user_1');
    await prisma.appSetting.update({
      where: { key: `${PREFIX}:${stale.state}` },
      data: { value: JSON.stringify({ ...stale, expiresAt: Date.now() - 1 }) },
    });

    await createGithubCsrf('other', 'user_2');

    expect(await rowCount()).toBe(1);
    const refused = await consumeGithubCsrf(stale.state);
    expect(refused.ok).toBe(false);
  });
});
