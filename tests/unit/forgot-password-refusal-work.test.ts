/**
 * F-709: a forgot-password request the rate limiter refuses must do no work —
 * before the fix every refused request still ran `dummyWork()`, a cost-12
 * bcrypt, so exceeding the limit made requests MORE expensive to serve. The
 * response is byte-identical either way, so there is no timing signal that
 * needs equalising on the refused path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const passwordMock = vi.hoisted(() => ({ hashPassword: vi.fn(async () => 'hashed') }));

vi.mock('@/lib/password', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/password')>();
  return { ...actual, hashPassword: passwordMock.hashPassword };
});
vi.mock('@/lib/db', () => ({
  prisma: { user: { findUnique: vi.fn(async () => null) } },
}));
vi.mock('@/lib/email/client', () => ({ sendEmail: vi.fn() }));

import { clearPasswordResetRateLimits, EMAIL_LIMIT } from '@/lib/password-reset/rate-limit';
import { GENERIC_FORGOT_MESSAGE, requestPasswordReset } from '@/lib/password-reset/service';

describe('refused forgot-password requests burn no bcrypt', () => {
  beforeEach(() => {
    clearPasswordResetRateLimits();
    passwordMock.hashPassword.mockClear();
  });

  it('a rate-limited request returns the generic message without hashing', async () => {
    const email = 'someone@example.com';
    for (let i = 0; i < EMAIL_LIMIT; i += 1) {
      await requestPasswordReset({ email, ip: '203.0.113.5' });
    }
    // Unknown user: each allowed request equalises timing with one hash.
    expect(passwordMock.hashPassword).toHaveBeenCalledTimes(EMAIL_LIMIT);

    const refused = await requestPasswordReset({ email, ip: '203.0.113.5' });
    expect(refused).toEqual({ ok: true, message: GENERIC_FORGOT_MESSAGE });
    expect(passwordMock.hashPassword).toHaveBeenCalledTimes(EMAIL_LIMIT);
  });

  it('a syntactically invalid email still equalises timing with one hash', async () => {
    await requestPasswordReset({ email: 'not-an-email', ip: '203.0.113.5' });
    expect(passwordMock.hashPassword).toHaveBeenCalledTimes(1);
  });
});
