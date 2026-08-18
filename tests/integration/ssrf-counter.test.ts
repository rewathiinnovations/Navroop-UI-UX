import '../setup/env';
import { afterAll, describe, expect, it } from 'vitest';
import { testPrismaClient } from '../setup/db';
import { assertSafeUrl, UnsafeUrlError } from '@/lib/security/url-guard';
import { safeFetch } from '@/lib/security/safe-fetch';
import { getSsrfPrivateRejectCounts } from '@/lib/security/reject-log';

/**
 * The private-range reject counter on /admin/usage is how an operator sees an active SSRF
 * probe. The reject path used to fire the counter write and discard the promise, so by the
 * time anything read the counter the write might not have happened — an active probe
 * under-reported as no activity. The write is now awaited before the rejection reaches
 * the caller.
 *
 * These tests read the counter immediately after the rejection, with no sleeping.
 *
 * `ssrf.privateRejects` is one AppSetting row for the whole database. Asserting
 * `counts.total` (or deleting the row in beforeEach) races every other suite that
 * increments it — `raw-sql-parse` calls `incrementPrivateReject` just to prove the
 * statement parses. The per-user bucket is the isolation the data model already has.
 * Snapshot it, do the work, assert the delta. The same shape applies to any other
 * singleton counter (`sandbox.teardownLeaks` included): never assert an absolute
 * global total; assert the slice this suite owns (here `byUser[USER]`, there an
 * `open` entry keyed by project/sandbox id).
 */

const prisma = testPrismaClient();
const USER = 'user_ssrf_counter';

async function rejectsForUser() {
  const counts = await getSsrfPrivateRejectCounts();
  return counts.byUser[USER] ?? 0;
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('ssrf private-range reject counter', () => {
  it('has already counted the reject by the time assertSafeUrl rejects', async () => {
    const before = await rejectsForUser();
    await expect(assertSafeUrl('http://127.0.0.1/admin', { userId: USER })).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );

    expect(await rejectsForUser()).toBe(before + 1);
  });

  it('counts every attempt in a burst', async () => {
    const before = await rejectsForUser();
    for (let i = 0; i < 3; i += 1) {
      await expect(assertSafeUrl('http://169.254.169.254/latest', { userId: USER })).rejects.toThrow();
    }
    expect(await rejectsForUser()).toBe(before + 3);
  });

  it('counts a private target reached through safeFetch', async () => {
    const before = await rejectsForUser();
    await expect(
      safeFetch('http://10.0.0.1/internal', {
        userId: USER,
        fetchImpl: async () => new Response('should never be fetched'),
      }),
    ).rejects.toBeInstanceOf(UnsafeUrlError);

    expect(await rejectsForUser()).toBe(before + 1);
  });

  it('does not count rejections that are not private-range, so the number stays meaningful', async () => {
    const before = await rejectsForUser();
    await expect(assertSafeUrl('ftp://example.com/x', { userId: USER })).rejects.toThrow();
    await expect(assertSafeUrl('http://example.com:8080/x', { userId: USER })).rejects.toThrow();

    expect(await rejectsForUser()).toBe(before);
  });

  it('still counts nothing when there is no user to attribute the reject to', async () => {
    const before = await rejectsForUser();
    await expect(assertSafeUrl('http://127.0.0.1/x')).rejects.toThrow();
    expect(await rejectsForUser()).toBe(before);
  });
});
