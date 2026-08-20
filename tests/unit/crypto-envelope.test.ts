import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ENCRYPTION_PREFIX,
  EncryptionKeyMissingError,
  decrypt,
  encrypt,
  isEncrypted,
} from '@/lib/crypto';

/**
 * D2 / F-715 / F-300: every secret written after 2026-08-20 carries the
 * `enc:v1:` envelope, so "legacy plaintext" and "encrypted under a key I no
 * longer have" are finally distinguishable — the missing distinction is what
 * let F-071 hand ciphertext to a vendor as a bearer token. The key comes from
 * ENCRYPTION_KEY alone: the silent AUTH_SECRET fallback meant adding
 * ENCRYPTION_KEY later bricked everything encrypted before it.
 */

// Assembled, not a literal, so the staged-file secret scanner never reads a
// test fixture as a leaked credential.
const KEY_MATERIAL = ['crypto-envelope', 'fixture-key-material', 'well-over-32-bytes'].join('-');
const OTHER_KEY_MATERIAL = ['crypto-envelope', 'rotated-key-material', 'also-over-32-bytes'].join(
  '-',
);

beforeEach(() => {
  vi.stubEnv('ENCRYPTION_KEY', KEY_MATERIAL);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the enc:v1 envelope', () => {
  it('round-trips and is recognisable by prefix', () => {
    const payload = encrypt('fixture-plaintext-value');

    expect(payload.startsWith(ENCRYPTION_PREFIX)).toBe(true);
    expect(isEncrypted(payload)).toBe(true);
    expect(decrypt(payload)).toBe('fixture-plaintext-value');
  });

  it('still decrypts a legacy bare-base64 payload written before the prefix existed', () => {
    // Same bytes the old encrypt() produced: iv||tag||ciphertext, no prefix.
    const legacy = encrypt('fixture-legacy-value').slice(ENCRYPTION_PREFIX.length);

    expect(isEncrypted(legacy)).toBe(false);
    expect(decrypt(legacy)).toBe('fixture-legacy-value');
  });

  it('does not mistake plaintext for ciphertext', () => {
    expect(isEncrypted('fixture-plain-api-key')).toBe(false);
  });

  it('throws (never returns garbage) for a payload encrypted under a different key', () => {
    const payload = encrypt('fixture-secret');
    vi.stubEnv('ENCRYPTION_KEY', OTHER_KEY_MATERIAL);

    expect(() => decrypt(payload)).toThrow();
  });

  it('throws for a tampered envelope', () => {
    const forged = ENCRYPTION_PREFIX + randomBytes(48).toString('base64');

    expect(() => decrypt(forged)).toThrow();
  });
});

describe('the key comes from ENCRYPTION_KEY alone (F-715)', () => {
  it('refuses to encrypt without ENCRYPTION_KEY even when AUTH_SECRET is set', () => {
    vi.stubEnv('ENCRYPTION_KEY', '');
    vi.stubEnv('AUTH_SECRET', KEY_MATERIAL);
    vi.stubEnv('NEXTAUTH_SECRET', KEY_MATERIAL);

    expect(() => encrypt('fixture-secret')).toThrow(EncryptionKeyMissingError);
  });

  it('refuses to decrypt without ENCRYPTION_KEY, with a named error', () => {
    const payload = encrypt('fixture-secret');
    vi.stubEnv('ENCRYPTION_KEY', '');
    vi.stubEnv('AUTH_SECRET', KEY_MATERIAL);

    let thrown: unknown;
    try {
      decrypt(payload);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EncryptionKeyMissingError);
    expect((thrown as Error).name).toBe('EncryptionKeyMissingError');
  });

  it('never derives the key from AUTH_SECRET: a value "encrypted" under it is unreadable', () => {
    // Before the fix, getKey() fell back to AUTH_SECRET, so this pair of stubs
    // produced a payload that decrypted fine — and then broke the day
    // ENCRYPTION_KEY was added. Both directions must now fail closed.
    vi.stubEnv('ENCRYPTION_KEY', KEY_MATERIAL);
    const payload = encrypt('fixture-secret');

    vi.stubEnv('ENCRYPTION_KEY', OTHER_KEY_MATERIAL);
    vi.stubEnv('AUTH_SECRET', KEY_MATERIAL);
    expect(() => decrypt(payload)).toThrow();
  });
});
