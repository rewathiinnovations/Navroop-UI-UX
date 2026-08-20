import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Configuration now resolves database → environment → registry fallback, and the
 * whole "no environment variables needed" promise rests on that order holding.
 * A regression here is silent: the app keeps serving, just with the wrong
 * credential, which is the worst way for this to fail.
 */

const findUnique = vi.fn();
const findMany = vi.fn().mockResolvedValue([]);

const logSpies = vi.hoisted(() => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logError: vi.fn(),
  formatLogLine: vi.fn(() => ''),
}));

vi.mock('@/lib/logger', () => logSpies);

vi.mock('@/lib/db', () => ({
  prisma: {
    appSetting: {
      findUnique: (...args: unknown[]) => findUnique(...args),
      findMany: (...args: unknown[]) => findMany(...args),
    },
  },
}));

// The suite reassigns process.env between cases, so the key that lib/crypto
// derives from is pinned here rather than inherited from the shell. It must be
// ENCRYPTION_KEY: getKey() no longer falls back to AUTH_SECRET (F-715).
const TEST_KEY_MATERIAL = ['settings-resolve', 'test-value', 'at-least-32-bytes'].join('-');
process.env.ENCRYPTION_KEY = TEST_KEY_MATERIAL;

const { encrypt } = await import('@/lib/crypto');
const { getSetting, invalidateSettingsCache, describeSettings } =
  await import('@/lib/settings/resolve');

/** Matches the shape `saveSettings` writes. */
function storedRow(value: string, encrypted = false) {
  return { value: JSON.stringify({ value: encrypted ? encrypt(value) : value, encrypted }) };
}

const ORIGINAL_ENV = { ...process.env, ENCRYPTION_KEY: TEST_KEY_MATERIAL };

beforeEach(() => {
  invalidateSettingsCache();
  findUnique.mockReset();
  findUnique.mockResolvedValue(null);
  findMany.mockReset();
  findMany.mockResolvedValue([]);
  logSpies.log.error.mockClear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  invalidateSettingsCache();
});

describe('getSetting precedence', () => {
  it('prefers a stored value over the environment variable', async () => {
    process.env.GITHUB_OAUTH_CLIENT_ID = 'from-env';
    findUnique.mockResolvedValue(storedRow('from-db'));

    expect(await getSetting('github.oauth.clientId')).toBe('from-db');
  });

  it('falls back to the environment variable when nothing is stored', async () => {
    process.env.GITHUB_OAUTH_CLIENT_ID = 'from-env';
    findUnique.mockResolvedValue(null);

    expect(await getSetting('github.oauth.clientId')).toBe('from-env');
  });

  it('falls back to the registry default when neither is set', async () => {
    delete process.env.GITHUB_OAUTH_CALLBACK_URL;

    expect(await getSetting('github.oauth.callbackUrl')).toBe(
      'http://localhost:3000/api/github/callback',
    );
  });

  it('returns null for a setting configured nowhere', async () => {
    delete process.env.UNSPLASH_ACCESS_KEY;

    expect(await getSetting('tooling.unsplash.accessKey')).toBeNull();
  });

  it('honours a legacy environment name when the current one is unset', async () => {
    delete process.env.ELK_BUCKET;
    process.env.S3_BUCKET = 'legacy-bucket';

    expect(await getSetting('storage.s3.bucket')).toBe('legacy-bucket');
  });

  it('keeps serving from the environment when the database is unreachable', async () => {
    process.env.RESEND_API_KEY = 'from-env';
    findUnique.mockRejectedValue(new Error('connection refused'));

    expect(await getSetting('email.resend.apiKey')).toBe('from-env');
  });

  it('reads an unknown key as null instead of throwing', async () => {
    expect(await getSetting('nope.not.a.setting')).toBeNull();
  });
});

describe('secret storage', () => {
  it('round-trips an encrypted secret', async () => {
    delete process.env.DEEPSEEK_API_KEY;
    findUnique.mockResolvedValue(storedRow('sk-deepseek-secret', true));

    expect(await getSetting('ai.deepseek.apiKey')).toBe('sk-deepseek-secret');
  });

  it('falls back to the environment when stored ciphertext cannot be decrypted, and logs the key', async () => {
    // What a rotated ENCRYPTION_KEY looks like: the row is present but unreadable.
    process.env.DEEPSEEK_API_KEY = 'from-env';
    findUnique.mockResolvedValue({
      value: JSON.stringify({ value: 'not-valid-ciphertext', encrypted: true }),
    });

    expect(await getSetting('ai.deepseek.apiKey')).toBe('from-env');
    // F-076: a present-but-corrupt value must never *silently* become the env value.
    expect(logSpies.log.error).toHaveBeenCalledWith(
      'settings.secret_undecryptable',
      expect.objectContaining({ key: 'ai.deepseek.apiKey' }),
    );
  });
});

describe('database failures are served but never cached (F-075)', () => {
  it('does not pin a value resolved from a failed read for 30 seconds', async () => {
    process.env.RESEND_API_KEY = 'from-env';
    findUnique.mockRejectedValueOnce(new Error('connection reset'));
    findUnique.mockResolvedValue(storedRow('from-db'));

    // The blip is served from the environment…
    expect(await getSetting('email.resend.apiKey')).toBe('from-env');
    // …and logged…
    expect(logSpies.log.error).toHaveBeenCalledWith(
      'settings.db_read_failed',
      expect.objectContaining({ key: 'email.resend.apiKey' }),
    );
    // …but the very next read reaches the recovered database instead of a
    // 30-second cache of the downgraded value.
    expect(await getSetting('email.resend.apiKey')).toBe('from-db');
  });

  it('still caches a successful resolution', async () => {
    findUnique.mockResolvedValueOnce(storedRow('from-db'));
    findUnique.mockResolvedValue(storedRow('changed-later'));

    expect(await getSetting('email.resend.apiKey')).toBe('from-db');
    expect(await getSetting('email.resend.apiKey')).toBe('from-db');
    expect(findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('describeSettings', () => {
  it('masks secrets and never returns their plaintext', async () => {
    delete process.env.DEEPSEEK_API_KEY;
    findMany.mockResolvedValue([
      { key: 'setting:ai.deepseek.apiKey', value: storedRow('sk-ant-abcd1234', true).value },
    ]);

    const { settings } = await describeSettings();
    const row = settings.find((setting) => setting.key === 'ai.deepseek.apiKey');

    expect(row?.source).toBe('db');
    expect(row?.configured).toBe(true);
    expect(row?.value).toBeNull();
    expect(row?.masked).toBe('••••••••1234');
    expect(JSON.stringify(settings)).not.toContain('sk-ant-abcd1234');
  });

  it('marks a stored-but-unreadable secret as undecryptable, not merely absent (F-076)', async () => {
    process.env.DEEPSEEK_API_KEY = 'from-env';
    findMany.mockResolvedValue([
      {
        key: 'setting:ai.deepseek.apiKey',
        value: JSON.stringify({ value: 'not-valid-ciphertext', encrypted: true }),
      },
    ]);

    const { settings } = await describeSettings();
    const row = settings.find((setting) => setting.key === 'ai.deepseek.apiKey');

    expect(row?.undecryptable).toBe(true);
    // The resolution direction is unchanged: env still serves the request.
    expect(row?.source).toBe('env');
  });

  it('reports where each value came from', async () => {
    process.env.GITHUB_OAUTH_CLIENT_ID = 'from-env';
    delete process.env.UNSPLASH_ACCESS_KEY;
    delete process.env.GITHUB_OAUTH_CALLBACK_URL;
    findMany.mockResolvedValue([]);

    const { settings } = await describeSettings();
    const sourceOf = (key: string) => settings.find((s) => s.key === key)?.source;

    expect(sourceOf('github.oauth.clientId')).toBe('env');
    expect(sourceOf('github.oauth.callbackUrl')).toBe('fallback');
    expect(sourceOf('tooling.unsplash.accessKey')).toBe('unset');
  });
});
