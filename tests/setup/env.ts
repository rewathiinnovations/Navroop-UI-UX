import { resolve } from 'node:path';
import { config } from 'dotenv';
import { applyTestDatabaseUrl } from '../../lib/verify/test-db';

config({ path: resolve(process.cwd(), '.env') });
config({ path: resolve(process.cwd(), '.env.local'), override: true });
config({ path: resolve(process.cwd(), '.env.test'), override: true });

if (!process.env.TEST_DATABASE_URL && process.env.DATABASE_URL) {
  try {
    const parsed = new URL(process.env.DATABASE_URL);
    const current = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    if (current && current !== 'openlovable_test') {
      parsed.pathname = '/openlovable_test';
      process.env.TEST_DATABASE_URL = parsed.toString();
    }
  } catch {
    // leave unset — assert below will fail closed
  }
}

applyTestDatabaseUrl(process.env);
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
