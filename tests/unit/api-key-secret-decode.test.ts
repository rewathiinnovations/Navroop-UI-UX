import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-071: a stored ApiKey/OrgApiKey secret now resolves in exactly three ways —
 * enveloped and readable → the plaintext; enveloped but undecryptable → null
 * plus a log line naming the row (NEVER the ciphertext, which used to be sent
 * to the vendor as a bearer token); bare legacy value → decrypt if it is
 * old-format ciphertext, otherwise accept as pre-encryption plaintext until
 * the backfill runs.
 */

const KEY_MATERIAL = ['api-key-decode', 'fixture-key-material', 'over-32-bytes-long'].join('-');
process.env.ENCRYPTION_KEY = KEY_MATERIAL;

const store = vi.hoisted(() => ({
  personal: null as { id: string; secret: string } | null,
  org: null as { id: string; secret: string } | null,
  settings: new Map<string, string>(),
}));

const logSpies = vi.hoisted(() => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logError: vi.fn(),
  formatLogLine: vi.fn(() => ''),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    apiKey: { findFirst: async () => store.personal },
    orgApiKey: { findFirst: async () => store.org },
    appSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        const value = store.settings.get(where.key);
        return value === undefined ? null : { value };
      },
    },
  },
}));

vi.mock('@/lib/logger', () => logSpies);

// Dynamic on purpose: the vi.mock calls above must register before the module
// under test resolves its own imports.
const { getEffectiveApiKey } = await import('@/lib/api-keys');
const { loadEffectiveProviderEnv } = await import('@/lib/ai/effective-env');
const { encrypt, ENCRYPTION_PREFIX } = await import('@/lib/crypto');
const { invalidateSettingsCache } = await import('@/lib/settings/resolve');

function storeAdminSetting(key: string, value: string) {
  store.settings.set(`setting:${key}`, JSON.stringify({ value, encrypted: false }));
  invalidateSettingsCache(key);
}

/** Enveloped, but under no key anyone has: guaranteed decrypt failure. */
function corruptEnvelope() {
  return ENCRYPTION_PREFIX + randomBytes(48).toString('base64');
}

beforeEach(() => {
  store.personal = null;
  store.org = null;
  store.settings.clear();
  invalidateSettingsCache();
  logSpies.log.error.mockClear();
  vi.stubEnv('DEEPSEEK_API_KEY', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('decodeStoredSecret three-way distinction (F-071)', () => {
  it('returns the plaintext for an enveloped, readable personal key', async () => {
    store.personal = { id: 'key_1', secret: encrypt('fx-personal') };

    expect(await getEffectiveApiKey('user-1', 'deepseek')).toBe('fx-personal');
  });

  it('never returns the ciphertext of an undecryptable row — it falls through and logs', async () => {
    const corrupt = corruptEnvelope();
    store.personal = { id: 'key_corrupt', secret: corrupt };
    storeAdminSetting('ai.deepseek.apiKey', 'fixture-admin-value');

    const resolved = await getEffectiveApiKey('user-1', 'deepseek');

    expect(resolved).toBe('fixture-admin-value');
    expect(resolved).not.toBe(corrupt);
    expect(logSpies.log.error).toHaveBeenCalled();
    const [event, fields] = logSpies.log.error.mock.calls[0] as [string, Record<string, unknown>];
    expect(event).toBe('api_keys.secret_undecryptable');
    expect(fields.provider).toBe('deepseek');
    expect(fields.rowId).toBe('key_corrupt');
    // The log line names the row, never the value.
    expect(JSON.stringify(logSpies.log.error.mock.calls)).not.toContain(corrupt);
  });

  it('surfaces provider-not-configured when the only row is undecryptable', async () => {
    store.org = { id: 'org_corrupt', secret: corruptEnvelope() };

    expect(await getEffectiveApiKey(null, 'deepseek')).toBeNull();
    expect(logSpies.log.error).toHaveBeenCalledWith(
      'api_keys.secret_undecryptable',
      expect.objectContaining({ provider: 'deepseek', scope: 'org', rowId: 'org_corrupt' }),
    );
  });

  it('decrypts a legacy bare-base64 row written before the envelope existed', async () => {
    store.org = {
      id: 'org_legacy',
      secret: encrypt('fixture-legacy-cipher-value').slice(ENCRYPTION_PREFIX.length),
    };

    expect(await getEffectiveApiKey(null, 'deepseek')).toBe('fixture-legacy-cipher-value');
  });

  it('accepts a legacy plaintext row until the backfill has run', async () => {
    store.personal = { id: 'key_plain', secret: 'fx-legacy-plain' };

    expect(await getEffectiveApiKey('user-1', 'deepseek')).toBe('fx-legacy-plain');
    expect(logSpies.log.error).not.toHaveBeenCalled();
  });

  it('skips the personal tier entirely when no user id is given', async () => {
    store.personal = { id: 'key_1', secret: encrypt('fx-personal') };
    storeAdminSetting('ai.deepseek.apiKey', 'fixture-admin-value');

    expect(await getEffectiveApiKey(null, 'deepseek')).toBe('fixture-admin-value');
  });
});

describe('the env parameter is honoured (F-078)', () => {
  it('reads the provider env var from the env its caller threaded through', async () => {
    // Ambient DEEPSEEK_API_KEY is stubbed empty in beforeEach; before the fix
    // the env tier read process.env directly and answered null here.
    const resolved = await getEffectiveApiKey(null, 'deepseek', {
      DEEPSEEK_API_KEY: 'fx-thread-env',
    });

    expect(resolved).toBe('fx-thread-env');
  });

  it('threads the overlay base env into resolution', async () => {
    const overlay = await loadEffectiveProviderEnv(null, {
      DEEPSEEK_API_KEY: 'fx-thread-env',
    });

    expect(overlay.DEEPSEEK_API_KEY).toBe('fx-thread-env');
  });
});
