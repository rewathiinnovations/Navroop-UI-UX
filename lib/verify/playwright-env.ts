import { resolve } from 'node:path';
import { config } from 'dotenv';

const MIN_ENCRYPTION_KEY_BYTES = 32;

/**
 * Test-only placeholder for Playwright / NODE_ENV=test. Not a production secret.
 * Used solely so `next start` can boot when CI or local has no ENCRYPTION_KEY.
 */
const PLAYWRIGHT_TEST_ENCRYPTION_KEY = 'navroop-playwright-test-encryption-key!!';

export type PlaywrightServerPlan = {
  /** URL the tests target and the `webServer` block probes. */
  baseURL: string;
  /** Port a spawned `next dev` must bind (passed as PORT to the child). */
  port: number;
  /**
   * Whether an already-listening server may be reused. Playwright cannot ask a
   * server which git checkout it serves, and on this machine two worktrees run
   * two dev servers side by side — so reusing "whatever answers" can validate a
   * different branch's code (F-620). Reuse is therefore allowed ONLY when the
   * operator explicitly vouched for the target via PLAYWRIGHT_BASE_URL.
   */
  reuseExistingServer: boolean;
};

const DEFAULT_APP_PORT = 3000;

/**
 * Offset the derived local port away from the checkout's dev server. The suite
 * then boots its own `next dev` from THIS checkout instead of trusting a live
 * server whose identity it cannot verify.
 */
const LOCAL_PORT_OFFSET = 100;

function portOf(url: string): number | null {
  try {
    const parsed = new URL(url);
    if (parsed.port) return Number(parsed.port);
    if (parsed.protocol === 'https:') return 443;
    if (parsed.protocol === 'http:') return 80;
    return null;
  } catch {
    return null;
  }
}

/**
 * Decides where the Playwright suite points and whether it may reuse a server:
 * - `PLAYWRIGHT_BASE_URL` set → target it and reuse; the operator has vouched
 *   that whatever answers there is this checkout.
 * - otherwise → never reuse; spawn our own `next dev` on `PLAYWRIGHT_PORT`, or
 *   in CI on the APP_URL port (nothing listens there, so behaviour is unchanged),
 *   or locally on APP_URL's port + 100 so it cannot collide with either
 *   worktree's live dev server.
 */
export function resolvePlaywrightServer(
  env: NodeJS.ProcessEnv = process.env,
): PlaywrightServerPlan {
  const explicit = env.PLAYWRIGHT_BASE_URL?.trim();
  if (explicit) {
    const port = portOf(explicit);
    if (port === null) {
      throw new Error(`PLAYWRIGHT_BASE_URL is not a valid http(s) URL: ${explicit}`);
    }
    return { baseURL: explicit.replace(/\/+$/, ''), port, reuseExistingServer: true };
  }

  const appPort = (env.APP_URL && portOf(env.APP_URL)) || DEFAULT_APP_PORT;
  const rawPort = env.PLAYWRIGHT_PORT?.trim();
  let port: number;
  if (rawPort) {
    port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`PLAYWRIGHT_PORT is not a valid port: ${rawPort}`);
    }
  } else {
    port = env.CI ? appPort : appPort + LOCAL_PORT_OFFSET;
  }
  return { baseURL: `http://localhost:${port}`, port, reuseExistingServer: false };
}

export function loadPlaywrightDotenv(cwd = process.cwd()) {
  config({ path: resolve(cwd, '.env'), quiet: true });
  config({ path: resolve(cwd, '.env.local'), override: true, quiet: true });
}

export function playwrightWebServerEnv(
  env: NodeJS.ProcessEnv = process.env,
  server?: PlaywrightServerPlan,
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
  if (server) {
    // The spawned server MUST describe itself as the origin it actually serves:
    // auth redirects, signed preview URLs and NEXT_PUBLIC_APP_URL all derive
    // from these. In CI they already equal the served origin, so this is a
    // no-op there; locally the derived port differs from the dev server's.
    inherited.PORT = String(server.port);
    inherited.APP_URL = server.baseURL;
    inherited.NEXT_PUBLIC_APP_URL = server.baseURL;
    inherited.NEXTAUTH_URL = server.baseURL;
    inherited.AUTH_URL = server.baseURL;
  } else if (!inherited.NEXT_PUBLIC_APP_URL) {
    // An unset or mismatched NEXT_PUBLIC_APP_URL is fatal on boot. Derive it from
    // whatever origin this checkout already declares so a machine without the
    // variable can still run E2E.
    inherited.NEXT_PUBLIC_APP_URL =
      inherited.APP_URL || inherited.NEXTAUTH_URL || inherited.AUTH_URL || 'http://localhost:3000';
  }
  return inherited;
}
