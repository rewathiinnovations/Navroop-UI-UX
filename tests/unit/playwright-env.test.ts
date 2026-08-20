import { describe, expect, it } from 'vitest';
import { playwrightWebServerEnv, resolvePlaywrightServer } from '../../lib/verify/playwright-env';

describe('playwright webServer env', () => {
  it('includes ENCRYPTION_KEY of at least 32 bytes when env is unset', () => {
    const env = playwrightWebServerEnv({});
    expect(Buffer.byteLength(env.ENCRYPTION_KEY ?? '', 'utf8')).toBeGreaterThanOrEqual(32);
  });

  it('inherits parent DATABASE_URL, TEST_DATABASE_URL, and AUTH_SECRET', () => {
    const env = playwrightWebServerEnv({
      DATABASE_URL: 'postgresql://openlovable:openlovable@127.0.0.1:5433/openlovable',
      TEST_DATABASE_URL: 'postgresql://openlovable:openlovable@127.0.0.1:5433/openlovable_test',
      AUTH_SECRET: 'ci-test-secret',
    });
    expect(env.DATABASE_URL).toBe(
      'postgresql://openlovable:openlovable@127.0.0.1:5433/openlovable',
    );
    expect(env.TEST_DATABASE_URL).toBe(
      'postgresql://openlovable:openlovable@127.0.0.1:5433/openlovable_test',
    );
    expect(env.AUTH_SECRET).toBe('ci-test-secret');
  });

  it('keeps a parent ENCRYPTION_KEY that is already long enough', () => {
    const key = 'parent-provided-encryption-key-32b';
    const env = playwrightWebServerEnv({ ENCRYPTION_KEY: key });
    expect(env.ENCRYPTION_KEY).toBe(key);
  });

  it('pins the spawned server origin and port to the resolved plan', () => {
    const env = playwrightWebServerEnv(
      {
        APP_URL: 'http://localhost:3000',
        NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
        NEXTAUTH_URL: 'http://localhost:3000',
      },
      { baseURL: 'http://localhost:3100', port: 3100, reuseExistingServer: false },
    );
    expect(env.PORT).toBe('3100');
    expect(env.APP_URL).toBe('http://localhost:3100');
    expect(env.NEXT_PUBLIC_APP_URL).toBe('http://localhost:3100');
    expect(env.NEXTAUTH_URL).toBe('http://localhost:3100');
    expect(env.AUTH_URL).toBe('http://localhost:3100');
  });
});

describe('resolvePlaywrightServer', () => {
  it('never reuses an existing server unless PLAYWRIGHT_BASE_URL vouches for it', () => {
    // Two worktrees serve :3000 and :3001 on the reference machine; a probe
    // cannot tell which checkout answered (F-620). Without the operator's
    // explicit URL the plan must spawn its own server.
    const plan = resolvePlaywrightServer({ APP_URL: 'http://localhost:3001' });
    expect(plan.reuseExistingServer).toBe(false);
    expect(plan.port).toBe(3101);
    expect(plan.baseURL).toBe('http://localhost:3101');
  });

  it('reuses only the explicitly vouched PLAYWRIGHT_BASE_URL target', () => {
    const plan = resolvePlaywrightServer({
      PLAYWRIGHT_BASE_URL: 'http://localhost:3001/',
      APP_URL: 'http://localhost:3000',
    });
    expect(plan.reuseExistingServer).toBe(true);
    expect(plan.baseURL).toBe('http://localhost:3001');
    expect(plan.port).toBe(3001);
  });

  it('keeps CI on the APP_URL port with no reuse — nothing listens there', () => {
    const plan = resolvePlaywrightServer({ CI: '1', APP_URL: 'http://localhost:3000' });
    expect(plan).toEqual({
      baseURL: 'http://localhost:3000',
      port: 3000,
      reuseExistingServer: false,
    });
  });

  it('honours PLAYWRIGHT_PORT over the derived offset', () => {
    const plan = resolvePlaywrightServer({
      PLAYWRIGHT_PORT: '4567',
      APP_URL: 'http://localhost:3001',
    });
    expect(plan.port).toBe(4567);
    expect(plan.baseURL).toBe('http://localhost:4567');
    expect(plan.reuseExistingServer).toBe(false);
  });

  it('defaults to port 3100 when no APP_URL is declared', () => {
    const plan = resolvePlaywrightServer({});
    expect(plan.port).toBe(3100);
  });

  it('rejects an unparseable PLAYWRIGHT_BASE_URL instead of guessing', () => {
    expect(() => resolvePlaywrightServer({ PLAYWRIGHT_BASE_URL: 'not-a-url' })).toThrow(
      /PLAYWRIGHT_BASE_URL/,
    );
  });

  it('rejects a non-numeric PLAYWRIGHT_PORT', () => {
    expect(() => resolvePlaywrightServer({ PLAYWRIGHT_PORT: 'abc' })).toThrow(/PLAYWRIGHT_PORT/);
  });
});
