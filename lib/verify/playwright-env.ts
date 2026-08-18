import { resolve } from 'node:path';
import { config } from 'dotenv';

const MIN_ENCRYPTION_KEY_BYTES = 32;

/**
 * Test-only placeholder for Playwright / NODE_ENV=test. Not a production secret.
 * Used solely so `next start` can boot when CI or local has no ENCRYPTION_KEY.
 */
const PLAYWRIGHT_TEST_ENCRYPTION_KEY = 'navroop-playwright-test-encryption-key!!';

/** Where `pnpm start` listens during the Playwright run. */
const PLAYWRIGHT_ORIGIN = 'http://localhost:3000';

export function loadPlaywrightDotenv(cwd = process.cwd()) {
  config({ path: resolve(cwd, '.env'), quiet: true });
  config({ path: resolve(cwd, '.env.local'), override: true, quiet: true });
}

export function playwrightWebServerEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) {
      inherited[name] = value;
    }
  }
  const key = inherited.ENCRYPTION_KEY || '';
  if (!key || Buffer.byteLength(key, 'utf8') < MIN_ENCRYPTION_KEY_BYTES) {
    inherited.ENCRYPTION_KEY = PLAYWRIGHT_TEST_ENCRYPTION_KEY;
  }
  // `pnpm start` boots with NODE_ENV=production, where an unset or mismatched
  // NEXT_PUBLIC_APP_URL is fatal. Derive it from whatever origin this checkout
  // already declares so a machine without the variable can still run E2E.
  if (!inherited.NEXT_PUBLIC_APP_URL) {
    inherited.NEXT_PUBLIC_APP_URL =
      inherited.APP_URL || inherited.NEXTAUTH_URL || inherited.AUTH_URL || PLAYWRIGHT_ORIGIN;
  }
  return inherited;
}
