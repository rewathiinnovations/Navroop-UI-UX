import '../setup/env';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { testPrismaClient } from '../setup/db';
import {
  createPrismaCronClaimStore,
  cronClaimKey,
  cronClaimStaleMs,
  DEFAULT_CRON_CLAIM_STALE_MS,
} from '@/lib/cron/claim';

/**
 * The cron claim against real Postgres (F-708).
 *
 * `tests/unit/cron-overlap.test.ts` drives the same store over a fake that models the
 * advisory lock, which cannot catch a statement that does not parse or a `hashtext`/
 * `pg_advisory_xact_lock` signature that does not exist. This suite runs the actual SQL and
 * the actual `AppSetting` compare-and-delete, and settles the question the fake can only
 * assume: two overlapping claims issued at once, one winner.
 *
 * The cron name is deliberately not a real one, so nothing here collides with the
 * `cron.inflight.*` row a concurrently running suite (or a developer's dev server) might
 * hold. It is also absent from `CRON_CLAIM_STALE_MS`, which pins the default budget.
 */

const prisma = testPrismaClient();
const NAME = 'integration-claim-probe';
const KEY = cronClaimKey(NAME);
const claims = createPrismaCronClaimStore(prisma);

beforeEach(async () => {
  await prisma.appSetting.deleteMany({ where: { key: KEY } });
});

afterAll(async () => {
  await prisma.appSetting.deleteMany({ where: { key: KEY } });
  await prisma.$disconnect();
});

const NOW = new Date('2026-08-20T12:00:00.000Z');

describe('cron claim over Postgres', () => {
  it('uses the default in-flight budget for a name with no override', () => {
    expect(cronClaimStaleMs(NAME)).toBe(DEFAULT_CRON_CLAIM_STALE_MS);
  });

  it('takes the claim, blocks the second holder, and releases it', async () => {
    const first = await claims.claim(NAME, NOW);
    expect(first.claimed).toBe(true);
    if (!first.claimed) return;
    expect(first.abandoned).toBeNull();
    expect(await prisma.appSetting.findUnique({ where: { key: KEY } })).not.toBeNull();

    const second = await claims.claim(NAME, new Date(NOW.getTime() + 60_000));
    expect(second.claimed).toBe(false);
    if (second.claimed) return;
    expect(second.runningSince).toBe(NOW.toISOString());

    await first.claim.release();
    expect(await prisma.appSetting.findUnique({ where: { key: KEY } })).toBeNull();
  });

  it('lets exactly one of two simultaneous claims through', async () => {
    const [a, b] = await Promise.all([claims.claim(NAME, NOW), claims.claim(NAME, NOW)]);
    expect([a.claimed, b.claimed].filter(Boolean)).toHaveLength(1);

    const winner = a.claimed ? a : b;
    if (!winner.claimed) return;
    await winner.claim.release();
    expect(await prisma.appSetting.findUnique({ where: { key: KEY } })).toBeNull();
  });

  it('takes over a claim past its budget and reports the run it replaced', async () => {
    const dead = await claims.claim(NAME, NOW);
    expect(dead.claimed).toBe(true);
    if (!dead.claimed) return;

    const later = new Date(NOW.getTime() + DEFAULT_CRON_CLAIM_STALE_MS + 1);
    const taken = await claims.claim(NAME, later);
    expect(taken.claimed).toBe(true);
    if (!taken.claimed) return;
    expect(taken.abandoned?.startedAt).toBe(NOW.toISOString());
    expect(taken.abandoned?.ageMs).toBe(DEFAULT_CRON_CLAIM_STALE_MS + 1);

    // The zombie unwinding later must not evict the run that replaced it.
    await dead.claim.release();
    const row = await prisma.appSetting.findUnique({ where: { key: KEY } });
    expect(row?.value).toContain(taken.claim.runId);

    await taken.claim.release();
    expect(await prisma.appSetting.findUnique({ where: { key: KEY } })).toBeNull();
  });

  it('does not let an unparseable claim wedge the cron forever', async () => {
    await prisma.appSetting.create({ data: { key: KEY, value: 'not json' } });
    const result = await claims.claim(NAME, NOW);

    expect(result.claimed).toBe(true);
    if (!result.claimed) return;
    // Nothing is claimed about a run that cannot be identified, so no failed row is invented.
    expect(result.abandoned).toBeNull();
    await result.claim.release();
  });
});
