import { describe, expect, it } from 'vitest';
import { playwrightWebServerEnv } from '../../lib/verify/playwright-env';

describe('playwright webServer env', () => {
  it('includes ENCRYPTION_KEY of at least 32 bytes when env is unset', () => {
    const env = playwrightWebServerEnv({});
    expect(Buffer.byteLength(env.ENCRYPTION_KEY ?? '', 'utf8')).toBeGreaterThanOrEqual(32);
  });

  it('inherits parent DATABASE_URL, TEST_DATABASE_URL, and AUTH_SECRET', () => {
    const env = playwrightWebServerEnv({
      DATABASE_URL: 'postgresql://openlovable:openlovable@127.0.0.1:5433/openlovable',
      TEST_DATABASE_URL: 'postgresql://openlovable:openlovable@127.0.0.1:5433/openlovable_test',
      AUTH_SECRET: 'ci-auth-secret-not-for-production-use',
    });
    expect(env.DATABASE_URL).toBe(
      'postgresql://openlovable:openlovable@127.0.0.1:5433/openlovable',
    );
    expect(env.TEST_DATABASE_URL).toBe(
      'postgresql://openlovable:openlovable@127.0.0.1:5433/openlovable_test',
    );
    expect(env.AUTH_SECRET).toBe('ci-auth-secret-not-for-production-use');
  });

  it('keeps a parent ENCRYPTION_KEY that is already long enough', () => {
    const key = 'parent-provided-encryption-key-32b';
    const env = playwrightWebServerEnv({ ENCRYPTION_KEY: key });
    expect(env.ENCRYPTION_KEY).toBe(key);
  });
});
