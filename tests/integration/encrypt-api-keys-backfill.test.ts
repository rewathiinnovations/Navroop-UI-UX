import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * D2 backfill: scripts/encrypt-api-keys.ts wraps every stored ApiKey/OrgApiKey
 * secret in the enc:v1 envelope, in place, idempotently. Runs against the test
 * database only (tests/setup/env.ts rewrites DATABASE_URL before @/lib/db
 * loads); production runs the same function via
 * `node node_modules/tsx/dist/cli.mjs scripts/encrypt-api-keys.ts`.
 */

process.env.ENCRYPTION_KEY ||= ['backfill', 'integration', 'fixture-key-32-bytes-plus'].join('-');

// Dynamic on purpose: ENCRYPTION_KEY must be pinned before lib/crypto is used,
// and @/lib/db must load after tests/setup/env.ts has redirected DATABASE_URL.
const { prisma } = await import('@/lib/db');
const { decrypt, encrypt, isEncrypted, ENCRYPTION_PREFIX } = await import('@/lib/crypto');
const { runApiKeyBackfill } = await import('../../scripts/encrypt-api-keys');

const run = randomUUID().slice(0, 8);
const email = `backfill-${run}@test.invalid`;
const providerOf = (name: string) => `test-${run}-${name}`;

let userId = '';

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email, name: 'Backfill Fixture', passwordHash: 'x', role: 'MEMBER' },
  });
  userId = user.id;

  await prisma.apiKey.createMany({
    data: [
      { userId, provider: providerOf('plain'), secret: 'fx-plain-abcd', last4: 'abcd' },
      {
        userId,
        provider: providerOf('legacy'),
        secret: encrypt('fx-legacy-wxyz').slice(ENCRYPTION_PREFIX.length),
        last4: 'wxyz',
      },
      {
        userId,
        provider: providerOf('enveloped'),
        secret: encrypt('fx-envel-1234'),
        last4: '1234',
      },
    ],
  });
  await prisma.orgApiKey.create({
    data: {
      provider: providerOf('org-plain'),
      secret: 'fx-org-efgh',
      last4: 'efgh',
    },
  });
});

afterAll(async () => {
  await prisma.apiKey.deleteMany({ where: { userId } });
  await prisma.orgApiKey.deleteMany({ where: { provider: { startsWith: `test-${run}-` } } });
  await prisma.user.deleteMany({ where: { id: userId } });
});

describe('scripts/encrypt-api-keys.ts', () => {
  it('envelopes every row once, preserves plaintext values, and is idempotent', async () => {
    const first = await runApiKeyBackfill(prisma);

    const rows = await prisma.apiKey.findMany({
      where: { userId },
      select: { provider: true, secret: true, last4: true },
    });
    const byProvider = new Map(rows.map((row) => [row.provider, row]));

    for (const row of rows) expect(isEncrypted(row.secret)).toBe(true);
    expect(decrypt(byProvider.get(providerOf('plain'))!.secret)).toBe('fx-plain-abcd');
    expect(decrypt(byProvider.get(providerOf('legacy'))!.secret)).toBe('fx-legacy-wxyz');
    expect(decrypt(byProvider.get(providerOf('enveloped'))!.secret)).toBe('fx-envel-1234');
    // last4 untouched: it was derived from the plaintext at write time.
    expect(byProvider.get(providerOf('plain'))!.last4).toBe('abcd');

    const org = await prisma.orgApiKey.findUnique({
      where: { provider: providerOf('org-plain') },
      select: { secret: true },
    });
    expect(isEncrypted(org!.secret)).toBe(true);
    expect(decrypt(org!.secret)).toBe('fx-org-efgh');

    const firstUpdated = first.reduce((sum, report) => sum + report.updated, 0);
    expect(firstUpdated).toBeGreaterThanOrEqual(3);

    // Second run: everything already carries the envelope, nothing is touched.
    const second = await runApiKeyBackfill(prisma);
    const secondUpdated = second.reduce((sum, report) => sum + report.updated, 0);
    expect(secondUpdated).toBe(0);

    const after = await prisma.apiKey.findMany({
      where: { userId },
      select: { provider: true, secret: true },
    });
    expect(new Map(after.map((row) => [row.provider, row.secret]))).toEqual(
      new Map(rows.map((row) => [row.provider, row.secret])),
    );
  });
});
