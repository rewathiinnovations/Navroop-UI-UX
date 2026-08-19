/**
 * Identity of the E2E account, plus the guards deciding which database may
 * receive it. No side effects and no database work: the Playwright setup project
 * and `scripts/seed-e2e-account.ts` both import this, so the seeded row and the
 * credentials typed into the login form cannot drift apart.
 */
import { validateEmail } from '../../lib/password';

/** `.invalid` is a reserved TLD, so this address can never receive real mail. */
const DEFAULT_EMAIL = 'e2e-bot@navroop.invalid';

/**
 * The dashboard greets the first word of the name, so keep it distinctive —
 * `journeys-authenticated.spec.ts` asserts on that greeting.
 */
export const E2E_ACCOUNT_NAME = 'Playwright Journey Bot';

/** First word of `E2E_ACCOUNT_NAME`, as `app/(app)/dashboard/page.tsx` derives it. */
export const E2E_ACCOUNT_FIRST_NAME = E2E_ACCOUNT_NAME.split(/\s+/)[0];

/**
 * Second identity, for the journeys that have to prove a screen is ADMIN-only:
 * showing that a MEMBER is refused says nothing unless an ADMIN is shown
 * reaching the same screen. Derived from the member address rather than given
 * its own variable, so one `E2E_USER_EMAIL` override moves both and the two can
 * never end up naming the same row.
 */
export const E2E_ADMIN_ACCOUNT_NAME = 'Playwright Admin Bot';

export function adminAccountFor(account: E2eAccount): E2eAccount {
  const at = account.email.lastIndexOf('@');
  return {
    email: `${account.email.slice(0, at)}-admin${account.email.slice(at)}`,
    name: E2E_ADMIN_ACCOUNT_NAME,
    password: account.password,
  };
}

/**
 * Only ever used against a database on this machine. A non-local target must
 * supply `E2E_USER_PASSWORD`, so this literal can never become a login on a
 * server someone else can reach.
 */
const LOCAL_ONLY_PASSWORD = 'E2eLocal-Pw9';

/** Test databases are owned by Vitest; the seeded account has no business there. */
const FORBIDDEN_DATABASES = new Set(['openlovable_test', 'openlovable_shadow']);

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal']);

export type E2eAccount = {
  email: string;
  name: string;
  password: string;
};

export type E2eTarget = {
  /** Connection string for the application database the dev server is using. */
  databaseUrl: string;
  database: string;
  isLocal: boolean;
  account: E2eAccount;
};

export type E2eTargetResult = { ok: true; target: E2eTarget } | { ok: false; error: string };

function databaseNameOf(url: URL) {
  return decodeURIComponent(url.pathname.replace(/^\//, '')).split('?')[0];
}

/**
 * Resolves the seed target. `E2E_DATABASE_URL` wins over `DATABASE_URL` so an
 * operator can aim this somewhere else on purpose, and the guards below are what
 * make honouring either one safe.
 */
export function resolveE2eTarget(env: NodeJS.ProcessEnv = process.env): E2eTargetResult {
  const databaseUrl = (env.E2E_DATABASE_URL || env.DATABASE_URL || '').trim();
  if (!databaseUrl) {
    return {
      ok: false,
      error:
        'No database to seed: set DATABASE_URL (or E2E_DATABASE_URL) to the application database the dev server on :3000 is using.',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return { ok: false, error: 'The database URL for the E2E account is not parseable.' };
  }

  const database = databaseNameOf(parsed);
  if (!database) {
    return { ok: false, error: 'The database URL for the E2E account names no database.' };
  }
  if (FORBIDDEN_DATABASES.has(database)) {
    return {
      ok: false,
      error: `Refusing to seed the E2E account into "${database}". That database belongs to the Vitest suites; point E2E_DATABASE_URL at the application database instead.`,
    };
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isLocal = LOCAL_HOSTS.has(host);
  if (!isLocal && (env.E2E_SEED_ALLOW_DATABASE || '').trim() !== database) {
    return {
      ok: false,
      error: `Refusing to seed the E2E account into "${database}" on a host that is not this machine. If that really is the intended target, name it: E2E_SEED_ALLOW_DATABASE=${database}.`,
    };
  }

  const password = (env.E2E_USER_PASSWORD || '').trim() || (isLocal ? LOCAL_ONLY_PASSWORD : '');
  if (!password) {
    return {
      ok: false,
      error:
        'Set E2E_USER_PASSWORD: the built-in password is only used against a database on this machine.',
    };
  }
  if (password.length < 8) {
    return { ok: false, error: 'E2E_USER_PASSWORD must be at least 8 characters.' };
  }

  const email = (env.E2E_USER_EMAIL || DEFAULT_EMAIL).trim().toLowerCase();
  if (!validateEmail(email)) {
    return { ok: false, error: 'E2E_USER_EMAIL is not a valid email address.' };
  }

  return {
    ok: true,
    target: {
      databaseUrl,
      database,
      isLocal,
      account: { email, name: E2E_ACCOUNT_NAME, password },
    },
  };
}
