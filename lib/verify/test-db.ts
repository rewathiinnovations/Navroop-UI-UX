/**
 * Tests must never touch the development database.
 * Assert at process start; exit if TEST_DATABASE_URL is missing or equal to DATABASE_URL.
 */

export class TestDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestDatabaseError';
  }
}

function normalizeDbUrl(raw: string) {
  try {
    const parsed = new URL(raw);
    const db = decodeURIComponent(parsed.pathname.replace(/^\//, '')).toLowerCase();
    return {
      host: parsed.hostname.toLowerCase(),
      port: parsed.port || '5432',
      database: db,
      href: `${parsed.protocol}//${parsed.host}/${db}`,
    };
  } catch {
    return { host: '', port: '', database: raw.trim().toLowerCase(), href: raw.trim() };
  }
}

export function assertTestDatabaseUrl(testUrl?: string, appUrl?: string) {
  if (!testUrl?.trim()) {
    throw new TestDatabaseError(
      'TEST_DATABASE_URL must be set. Use a separate database (recommended: openlovable_test on 5433).',
    );
  }
  if (!appUrl?.trim()) {
    throw new TestDatabaseError('DATABASE_URL must be set so tests can prove they are not using it.');
  }
  const test = normalizeDbUrl(testUrl);
  const app = normalizeDbUrl(appUrl);
  if (test.href === app.href || (test.host === app.host && test.port === app.port && test.database === app.database)) {
    throw new TestDatabaseError(
      'TEST_DATABASE_URL must differ from DATABASE_URL (different database name, not the same URL).',
    );
  }
  return testUrl.trim();
}

export function applyTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env) {
  const testUrl = assertTestDatabaseUrl(env.TEST_DATABASE_URL, env.DATABASE_URL);
  env.DATABASE_URL = testUrl;
  return testUrl;
}
