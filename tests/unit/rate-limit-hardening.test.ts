/**
 * F-302 / F-709: the unauthenticated limiters must key on values the caller
 * cannot mint (email always; client IP only when a trusted proxy supplied it),
 * and their in-process stores must stay bounded and swept. Each block below
 * failed against the pre-fix code (first-hop XFF trust, `email|ip` pair key,
 * unbounded Map).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { clientIpFrom } from '../../lib/auth/client-ip';
import {
  LOGIN_ATTEMPT_LIMIT,
  LOGIN_IP_ATTEMPT_LIMIT,
  allowLoginAttempt,
  clearLoginRateLimits,
  recordLoginSuccess,
} from '../../lib/auth/login-rate-limit';
import {
  EMAIL_LIMIT,
  IP_LIMIT,
  allowPasswordResetRequest,
  clearPasswordResetRateLimits,
} from '../../lib/password-reset/rate-limit';
import { createRateLimitStore } from '../../lib/rate-limit/store';

describe('clientIpFrom', () => {
  it('uses the LAST x-forwarded-for hop — the one the trusted proxy appended', () => {
    const headers = new Headers({ 'x-forwarded-for': 'spoofed-a, spoofed-b, 203.0.113.9' });
    expect(clientIpFrom(headers, {})).toBe('203.0.113.9');
  });

  it('returns null when proxy headers are untrusted, even with a header present', () => {
    const headers = new Headers({ 'x-forwarded-for': 'spoofed-a, 203.0.113.9' });
    expect(clientIpFrom(headers, { TRUST_PROXY_HEADERS: '0' })).toBeNull();
    expect(clientIpFrom(headers, { TRUST_PROXY_HEADERS: 'false' })).toBeNull();
  });

  it('falls back to x-real-ip, and to null when nothing trustworthy exists', () => {
    expect(clientIpFrom(new Headers({ 'x-real-ip': '203.0.113.7' }), {})).toBe('203.0.113.7');
    expect(clientIpFrom(new Headers(), {})).toBeNull();
  });
});

describe('login rate limit buckets', () => {
  beforeEach(() => {
    clearLoginRateLimits();
  });

  it('the per-email limit holds when the caller rotates its IP', () => {
    const email = 'victim@example.com';
    for (let i = 0; i < LOGIN_ATTEMPT_LIMIT; i += 1) {
      expect(allowLoginAttempt(email, `198.51.100.${i}`).allowed).toBe(true);
    }
    expect(allowLoginAttempt(email, '198.51.100.200').allowed).toBe(false);
  });

  it('the per-IP limit holds when the caller rotates emails', () => {
    const ip = '198.51.100.9';
    for (let i = 0; i < LOGIN_IP_ATTEMPT_LIMIT; i += 1) {
      allowLoginAttempt(`spray-${i}@example.com`, ip);
    }
    expect(allowLoginAttempt('spray-final@example.com', ip).allowed).toBe(false);
  });

  it('with no trustworthy IP the email bucket alone throttles', () => {
    const email = 'victim@example.com';
    for (let i = 0; i < LOGIN_ATTEMPT_LIMIT; i += 1) {
      expect(allowLoginAttempt(email, null).allowed).toBe(true);
    }
    expect(allowLoginAttempt(email, null).allowed).toBe(false);
    // …and a different email is unaffected (no shared "unknown" bucket).
    expect(allowLoginAttempt('other@example.com', null).allowed).toBe(true);
  });

  it('success clears only the email bucket', () => {
    const email = 'member@example.com';
    for (let i = 0; i < LOGIN_ATTEMPT_LIMIT; i += 1) allowLoginAttempt(email, '203.0.113.4');
    recordLoginSuccess(email);
    expect(allowLoginAttempt(email, '203.0.113.4').allowed).toBe(true);
  });
});

describe('password-reset rate limit buckets', () => {
  beforeEach(() => {
    clearPasswordResetRateLimits();
  });

  it('per-email and per-IP buckets are independent', () => {
    for (let i = 0; i < EMAIL_LIMIT; i += 1) {
      expect(allowPasswordResetRequest('a@example.com', `198.51.100.${i}`)).toBe(true);
    }
    expect(allowPasswordResetRequest('a@example.com', '198.51.100.99')).toBe(false);

    clearPasswordResetRateLimits();
    for (let i = 0; i < IP_LIMIT; i += 1) {
      allowPasswordResetRequest(`u${i}@example.com`, '198.51.100.1');
    }
    expect(allowPasswordResetRequest('fresh@example.com', '198.51.100.1')).toBe(false);
  });

  it('a null IP skips the IP bucket instead of pooling callers', () => {
    for (let i = 0; i < IP_LIMIT + 5; i += 1) {
      allowPasswordResetRequest(`u${i}@example.com`, null);
    }
    expect(allowPasswordResetRequest('fresh@example.com', null)).toBe(true);
  });
});

describe('bounded rate-limit store', () => {
  it('never exceeds maxEntries; the least-recently-touched bucket is evicted', () => {
    const store = createRateLimitStore(3);
    const now = 1_000;
    store.hit('a', 5, 60_000, now);
    store.hit('b', 5, 60_000, now);
    store.hit('c', 5, 60_000, now);
    store.hit('a', 5, 60_000, now + 1); // refresh a — b is now oldest
    store.hit('d', 5, 60_000, now + 2); // evicts b
    expect(store.size()).toBe(3);
    // b restarts at count 1: its bucket was evicted, not remembered.
    expect(store.hit('b', 1, 60_000, now + 3).count).toBe(1);
    expect(store.size()).toBe(3);
  });

  it('sweeps expired buckets on every call', () => {
    const store = createRateLimitStore(100);
    for (let i = 0; i < 50; i += 1) store.hit(`k${i}`, 5, 1_000, 0);
    expect(store.size()).toBe(50);
    store.hit('fresh', 5, 1_000, 5_000); // every k* window ended at 1_000
    expect(store.size()).toBe(1);
  });

  it('an expired bucket reopens with a fresh window', () => {
    const store = createRateLimitStore(10);
    expect(store.hit('k', 1, 1_000, 0).allowed).toBe(true);
    expect(store.hit('k', 1, 1_000, 10).allowed).toBe(false);
    expect(store.hit('k', 1, 1_000, 2_000).allowed).toBe(true);
  });
});
