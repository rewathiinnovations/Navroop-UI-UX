import { describe, expect, it } from 'vitest';
import { assertReleaseEnv, failClosedReleaseEnv } from '../../lib/verify/env-assert';
import { TestDatabaseError, applyTestDatabaseUrl, assertTestDatabaseUrl } from '../../lib/verify/test-db';

describe('release env assert', () => {
  it('fails closed with a readable message when ENCRYPTION_KEY is missing', () => {
    const result = assertReleaseEnv({
      DATABASE_URL: 'postgresql://x:y@127.0.0.1:5432/navroop',
      APP_URL: 'https://navroop.example',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toContain('ENCRYPTION_KEY');
      expect(result.error).toMatch(/ENCRYPTION_KEY is missing/);
    }
  });

  it('fails when ENCRYPTION_KEY is shorter than 32 bytes', () => {
    const result = assertReleaseEnv({
      DATABASE_URL: 'postgresql://x:y@127.0.0.1:5432/navroop',
      APP_URL: 'https://navroop.example',
      ENCRYPTION_KEY: 'short-key-not-32-bytes',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/too short/);
    }
  });

  it('names DATABASE_URL and APP_URL when missing', () => {
    const result = assertReleaseEnv({ ENCRYPTION_KEY: 'x'.repeat(32) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual(expect.arrayContaining(['DATABASE_URL', 'APP_URL']));
    }
  });

  it('accepts a 32-byte key and APP_URL alias', () => {
    expect(
      assertReleaseEnv({
        DATABASE_URL: 'postgresql://x:y@127.0.0.1:5432/navroop',
        NEXTAUTH_URL: 'https://navroop.example',
        ENCRYPTION_KEY: 'x'.repeat(32),
      }).ok,
    ).toBe(true);
    expect(
      assertReleaseEnv({
        DATABASE_URL: 'postgresql://x:y@127.0.0.1:5432/navroop',
        AUTH_URL: 'https://navroop.example',
        ENCRYPTION_KEY: 'x'.repeat(32),
      }).ok,
    ).toBe(true);
    expect(() =>
      failClosedReleaseEnv({
        DATABASE_URL: 'postgresql://x:y@127.0.0.1:5432/navroop',
        APP_URL: 'https://navroop.example',
        ENCRYPTION_KEY: 'x'.repeat(32),
      }),
    ).not.toThrow();
  });

  it('throws a closed error when release env is incomplete', () => {
    expect(() => failClosedReleaseEnv({ ENCRYPTION_KEY: 'x'.repeat(32) })).toThrow(
      /Release env check failed/,
    );
  });

  it('treats whitespace-only DATABASE_URL as missing', () => {
    const result = assertReleaseEnv({
      DATABASE_URL: '   ',
      APP_URL: 'https://navroop.example',
      ENCRYPTION_KEY: 'x'.repeat(32),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missing).toContain('DATABASE_URL');
  });
});

describe('test database guard', () => {
  it('rejects the same URL and the same database name on the same host', () => {
    expect(() =>
      assertTestDatabaseUrl(
        'postgresql://openlovable:openlovable@127.0.0.1:5433/openlovable',
        'postgresql://openlovable:openlovable@127.0.0.1:5433/openlovable',
      ),
    ).toThrow(TestDatabaseError);
    expect(() =>
      assertTestDatabaseUrl(
        'postgresql://openlovable:openlovable@127.0.0.1:5433/openlovable',
        'postgresql://openlovable:openlovable@127.0.0.1:5433/openlovable?schema=public',
      ),
    ).toThrow(/must differ/);
  });

  it('allows openlovable_test on the same port as the app database', () => {
    expect(
      assertTestDatabaseUrl(
        'postgresql://openlovable:openlovable@127.0.0.1:5433/openlovable_test',
        'postgresql://openlovable:openlovable@127.0.0.1:5433/openlovable',
      ),
    ).toContain('openlovable_test');
  });

  it('fails closed when either URL is missing', () => {
    expect(() => assertTestDatabaseUrl(undefined, 'postgresql://x:y@127.0.0.1:5433/app')).toThrow(
      /TEST_DATABASE_URL must be set/,
    );
    expect(() =>
      assertTestDatabaseUrl('postgresql://x:y@127.0.0.1:5433/openlovable_test', undefined),
    ).toThrow(/DATABASE_URL must be set/);
  });

  it('rewrites DATABASE_URL to the test database on the provided env', () => {
    const env = {
      TEST_DATABASE_URL: 'postgresql://openlovable:openlovable@127.0.0.1:5433/openlovable_test',
      DATABASE_URL: 'postgresql://openlovable:openlovable@127.0.0.1:5433/openlovable',
    };
    expect(applyTestDatabaseUrl(env)).toContain('openlovable_test');
    expect(env.DATABASE_URL).toContain('openlovable_test');
  });

  it('treats unparseable URLs with the same raw string as the same database', () => {
    expect(() => assertTestDatabaseUrl('not-a-url', 'not-a-url')).toThrow(/must differ/);
  });
});
