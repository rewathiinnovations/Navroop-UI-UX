import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { COOLIFY_SETTING_KEY } from '@/lib/coolify/constants.ts';

/**
 * F-252: the legacy Coolify AppSetting row.
 *
 * `saveStoredCoolifySettings` computed `nextToken = input.token || existing.token` and wrote
 * `tokenEncrypted: nextToken ? encrypt(nextToken) : null`. `existing.token` is null both when
 * there is no token and when the stored ciphertext could not be decrypted (a rotated
 * ENCRYPTION_KEY), so an operator saving only a new base URL destroyed a credential they
 * never touched — turning a recoverable key problem into a lost secret.
 *
 * The same finding covers the dead `'env'` arm of `getCoolifyCredentials().source`: no env
 * token is read anywhere (`lib/coolify/client.ts` says so), so `'env'` was unreachable and
 * every branch on it in the admin surface was dead.
 *
 * Goes red if a base-URL-only save can clear the token again, or if `'env'` comes back.
 */

const db = vi.hoisted(() => ({
  prisma: {
    appSetting: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}));
const crypto = vi.hoisted(() => ({ encrypt: vi.fn(), decrypt: vi.fn() }));

vi.mock('@/lib/db', () => db);
vi.mock('@/lib/crypto', () => crypto);

const { getStoredCoolifySettings, saveStoredCoolifySettings } =
  await import('@/lib/coolify/settings.ts');

/** What the save wrote back, parsed. */
function written() {
  const call = db.prisma.appSetting.upsert.mock.calls.at(-1)?.[0] as
    { update?: { value?: string } } | undefined;
  const raw = call?.update?.value;
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

beforeEach(() => {
  db.prisma.appSetting.findUnique.mockReset();
  db.prisma.appSetting.upsert.mockReset();
  db.prisma.appSetting.upsert.mockResolvedValue({ key: COOLIFY_SETTING_KEY });
  crypto.encrypt.mockReset();
  crypto.encrypt.mockImplementation((value: string) => `enc:${value}`);
  crypto.decrypt.mockReset();
  crypto.decrypt.mockImplementation((value: string) => value.replace(/^enc:/, ''));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('saveStoredCoolifySettings', () => {
  it('keeps a token that could not be decrypted when only the base URL changes', async () => {
    db.prisma.appSetting.findUnique.mockResolvedValue({
      value: JSON.stringify({
        baseUrl: 'https://old.example.test',
        tokenEncrypted: 'enc:unreadable',
        last4: 'cdef',
      }),
    });
    crypto.decrypt.mockImplementation(() => {
      throw new Error('Unsupported state or unable to authenticate data');
    });

    const saved = await saveStoredCoolifySettings({ baseUrl: 'https://new.example.test' });

    expect(written()?.tokenEncrypted).toBe('enc:unreadable');
    expect(written()?.baseUrl).toBe('https://new.example.test');
    expect(written()?.last4).toBe('cdef');
    expect(saved.baseUrl).toBe('https://new.example.test');
  });

  it('re-encrypts a readable token untouched when only the base URL changes', async () => {
    db.prisma.appSetting.findUnique.mockResolvedValue({
      value: JSON.stringify({
        baseUrl: 'https://old.example.test',
        tokenEncrypted: 'enc:live-token-value',
        last4: 'alue',
      }),
    });

    await saveStoredCoolifySettings({ baseUrl: 'https://new.example.test' });

    expect(written()?.tokenEncrypted).toBe('enc:live-token-value');
  });

  it('replaces the token when a new one is supplied', async () => {
    db.prisma.appSetting.findUnique.mockResolvedValue({
      value: JSON.stringify({ baseUrl: 'https://old.example.test', tokenEncrypted: 'enc:old' }),
    });

    await saveStoredCoolifySettings({ baseUrl: 'https://old.example.test', token: 'brand-new' });

    expect(written()?.tokenEncrypted).toBe('enc:brand-new');
  });

  it('writes no token when there never was one', async () => {
    db.prisma.appSetting.findUnique.mockResolvedValue(null);

    await saveStoredCoolifySettings({ baseUrl: 'https://new.example.test' });

    expect(written()?.tokenEncrypted).toBeNull();
    expect(written()?.last4).toBeNull();
  });
});

describe('getStoredCoolifySettings', () => {
  it('reports an undecryptable token as unreadable rather than as absent', async () => {
    db.prisma.appSetting.findUnique.mockResolvedValue({
      value: JSON.stringify({ baseUrl: 'https://x.example.test', tokenEncrypted: 'enc:x' }),
    });
    crypto.decrypt.mockImplementation(() => {
      throw new Error('bad key');
    });

    const stored = await getStoredCoolifySettings();

    expect(stored.token).toBeNull();
    expect(stored.tokenUnreadable).toBe(true);
  });

  it('reports no token as absent, not unreadable', async () => {
    db.prisma.appSetting.findUnique.mockResolvedValue(null);

    const stored = await getStoredCoolifySettings();

    expect(stored.token).toBeNull();
    expect(stored.tokenUnreadable).toBe(false);
  });
});
