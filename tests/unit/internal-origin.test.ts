import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  INTERNAL_ORIGIN_FALLBACK,
  assertInternalOrigin,
  checkInternalOrigin,
} from '../../lib/api/internal-origin';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('internal origin check', () => {
  it('accepts a value whose host matches APP_URL', () => {
    const result = checkInternalOrigin({
      NEXT_PUBLIC_APP_URL: 'https://app.example.com/',
      APP_URL: 'https://app.example.com',
    } as NodeJS.ProcessEnv);
    expect(result).toEqual({ ok: true, severity: 'ok', origin: 'https://app.example.com' });
  });

  it('accepts NEXTAUTH_URL and AUTH_URL as APP_URL aliases', () => {
    expect(
      checkInternalOrigin({
        NEXT_PUBLIC_APP_URL: 'https://app.example.com',
        NEXTAUTH_URL: 'https://app.example.com',
      } as NodeJS.ProcessEnv).ok,
    ).toBe(true);
    expect(
      checkInternalOrigin({
        NEXT_PUBLIC_APP_URL: 'https://app.example.com',
        AUTH_URL: 'https://app.example.com',
      } as NodeJS.ProcessEnv).ok,
    ).toBe(true);
  });

  it('accepts a value with no APP_URL to compare against', () => {
    expect(checkInternalOrigin({ NEXT_PUBLIC_APP_URL: 'http://localhost:3000' } as NodeJS.ProcessEnv).ok).toBe(true);
  });

  it('warns rather than errors when unset, leaving the fatal decision to the boot assertion', () => {
    const result = checkInternalOrigin({ APP_URL: 'https://app.example.com' } as NodeJS.ProcessEnv);
    expect(result.ok).toBe(false);
    expect(result.severity).toBe('warn');
    expect(result.origin).toBe(INTERNAL_ORIGIN_FALLBACK);
  });

  it('errors on a value that does not parse', () => {
    const result = checkInternalOrigin({ NEXT_PUBLIC_APP_URL: 'not a url' } as NodeJS.ProcessEnv);
    expect(result.ok).toBe(false);
    expect(result.severity).toBe('error');
  });

  it('errors when the host does not match APP_URL', () => {
    const result = checkInternalOrigin({
      NEXT_PUBLIC_APP_URL: 'https://other.example.com',
      APP_URL: 'https://app.example.com',
    } as NodeJS.ProcessEnv);
    expect(result.ok).toBe(false);
    expect(result.severity).toBe('error');
    expect(result.ok === false && result.error).toContain('does not match');
  });

  it('errors when APP_URL itself does not parse', () => {
    const result = checkInternalOrigin({
      NEXT_PUBLIC_APP_URL: 'https://app.example.com',
      APP_URL: 'nonsense',
    } as NodeJS.ProcessEnv);
    expect(result.ok).toBe(false);
    expect(result.severity).toBe('error');
  });

  it('treats a port difference as a mismatch', () => {
    expect(
      checkInternalOrigin({
        NEXT_PUBLIC_APP_URL: 'http://localhost:3001',
        APP_URL: 'http://localhost:3000',
      } as NodeJS.ProcessEnv).ok,
    ).toBe(false);
  });
});

describe('boot assertion', () => {
  it('says nothing when the origin is fine', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    assertInternalOrigin({ NEXT_PUBLIC_APP_URL: 'http://localhost:3000' } as NodeJS.ProcessEnv);
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs an error for a misconfigured origin', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    assertInternalOrigin({
      NEXT_PUBLIC_APP_URL: 'https://other.example.com',
      APP_URL: 'https://app.example.com',
    } as NodeJS.ProcessEnv);
    expect(error).toHaveBeenCalledOnce();
  });

  it('logs a warning when unset outside production and does not throw', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => assertInternalOrigin({} as NodeJS.ProcessEnv)).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('refuses to boot in production when the host does not match', () => {
    expect(() =>
      assertInternalOrigin({
        NODE_ENV: 'production',
        NEXT_PUBLIC_APP_URL: 'https://other.example.com',
        APP_URL: 'https://app.example.com',
      } as NodeJS.ProcessEnv),
    ).toThrow(/does not match/);
  });

  it('refuses to boot in production when unset', () => {
    expect(() => assertInternalOrigin({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(/is not set/);
  });

  it('refuses to boot in production when the value does not parse', () => {
    expect(() =>
      assertInternalOrigin({ NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: 'not a url' } as NodeJS.ProcessEnv),
    ).toThrow(/not a valid URL/);
  });

  it('still boots in production when the origin is fine', () => {
    expect(() =>
      assertInternalOrigin({
        NODE_ENV: 'production',
        NEXT_PUBLIC_APP_URL: 'https://app.example.com',
        APP_URL: 'https://app.example.com',
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
});

/**
 * `warnUnauthorizedInternalCall` and its tests were removed with the last
 * self-origin fetch in app/api/**. Those call sites are direct function calls
 * now, so a failure is a thrown exception or a typed result rather than a 401
 * that has to be noticed.
 */
