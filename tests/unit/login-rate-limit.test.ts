import { beforeEach, describe, expect, it } from 'vitest';
import {
  LOGIN_ATTEMPT_LIMIT,
  LOGIN_RATE_LIMIT_MESSAGE,
  allowLoginAttempt,
  clearLoginRateLimits,
  recordLoginSuccess,
} from '../../lib/auth/login-rate-limit';

describe('sign-in rate limit', () => {
  beforeEach(() => {
    clearLoginRateLimits();
  });

  it('blocks the 6th attempt', () => {
    const email = 'member@example.com';
    const ip = '203.0.113.10';
    for (let i = 0; i < LOGIN_ATTEMPT_LIMIT; i += 1) {
      expect(allowLoginAttempt(email, ip).allowed).toBe(true);
    }
    const sixth = allowLoginAttempt(email, ip);
    expect(sixth.allowed).toBe(false);
    expect(sixth.count).toBe(6);
    expect(LOGIN_RATE_LIMIT_MESSAGE).toMatch(/Too many sign-in attempts/);
  });

  it('resets after a successful sign-in', () => {
    const email = 'member@example.com';
    const ip = '203.0.113.11';
    for (let i = 0; i < LOGIN_ATTEMPT_LIMIT; i += 1) allowLoginAttempt(email, ip);
    recordLoginSuccess(email, ip);
    expect(allowLoginAttempt(email, ip).allowed).toBe(true);
  });
});
