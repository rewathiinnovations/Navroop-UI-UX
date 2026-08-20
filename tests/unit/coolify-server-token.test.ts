import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-216 — a decrypt failure used to be read as "this token was stored in plaintext".
 *
 * `decryptServerToken` caught the failure and returned the stored string, and the Coolify
 * transport additionally *guessed* whether a value was encrypted by testing it for `==` or
 * `length > 80`. On a rotated `ENCRYPTION_KEY` the ciphertext went out as
 * `Authorization: Bearer <ciphertext>` — so every Coolify call failed with an authentication
 * error that said nothing about encryption — while `/admin/servers` computed `last4` over the
 * same ciphertext and displayed it as if it were the token's, confirming a plausible-looking
 * credential was present.
 *
 * Wave 2 gave us the `enc:v1:` envelope, so encrypted and plaintext are now distinguishable
 * without guessing. These tests pin that: a prefixed value must decrypt or raise, and nothing
 * displayed may be derived from a value that failed to decrypt.
 */

const ORIGINAL_KEY = 'the-original-encryption-key-32-bytes!!!!';
const ROTATED_KEY = 'a-different-encryption-key-32-bytes-min!!';

vi.mock('@/lib/db', () => ({ prisma: {} }));

const { ENCRYPTION_PREFIX, encrypt } = await import('@/lib/crypto.ts');
const {
  ServerTokenUnreadableError,
  decryptServerToken,
  encryptServerToken,
  publicServer,
  serverAuth,
} = await import('@/lib/coolify/servers.ts');

let ciphertext = '';

beforeEach(() => {
  process.env.ENCRYPTION_KEY = ORIGINAL_KEY;
  ciphertext = encryptServerToken('coolify-live-token');
  process.env.ENCRYPTION_KEY = ROTATED_KEY;
});

afterEach(() => {
  process.env.ENCRYPTION_KEY = ORIGINAL_KEY;
});

function row(apiToken: string) {
  return {
    id: 'srv_1',
    name: 'eu-west-1',
    apiUrl: 'https://coolify.example.com',
    apiToken,
    serverIp: '203.0.113.10',
    projectUuid: 'proj-1',
    isActive: true,
    maxDeployments: 50,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
  };
}

describe('decryptServerToken', () => {
  it('raises instead of handing back the ciphertext as if it were the token', () => {
    expect(() => decryptServerToken(ciphertext)).toThrow(ServerTokenUnreadableError);
  });

  it('names the encryption key in the failure, and never the stored value', () => {
    let caught: unknown;
    try {
      decryptServerToken(ciphertext);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/encryption key/i);
    expect(message).not.toContain(ciphertext);
  });

  it('decrypts a value written under this instance key', () => {
    process.env.ENCRYPTION_KEY = ORIGINAL_KEY;
    expect(decryptServerToken(ciphertext)).toBe('coolify-live-token');
  });

  it('still reads a legacy bare-base64 ciphertext written before the envelope', () => {
    process.env.ENCRYPTION_KEY = ORIGINAL_KEY;
    const legacy = encrypt('legacy-token').slice(ENCRYPTION_PREFIX.length);
    expect(decryptServerToken(legacy)).toBe('legacy-token');
  });

  it('returns a genuinely plaintext legacy value unchanged', () => {
    expect(decryptServerToken('plain-legacy-token')).toBe('plain-legacy-token');
  });
});

describe('publicServer', () => {
  it('reports the token as unreadable rather than showing the ciphertext last4', () => {
    const view = publicServer(row(ciphertext));

    expect(view.tokenUnreadable).toBe(true);
    expect(view.last4).toBeNull();
    expect(JSON.stringify(view)).not.toContain(ciphertext.slice(-8));
  });

  it('shows last4 of the real token when it decrypts', () => {
    process.env.ENCRYPTION_KEY = ORIGINAL_KEY;

    const view = publicServer(row(ciphertext));

    expect(view.tokenUnreadable).toBe(false);
    expect(view.last4).toBe('oken');
  });
});

describe('serverAuth', () => {
  it('refuses to build an Authorization header from an unreadable token', () => {
    expect(() => serverAuth(row(ciphertext))).toThrow(ServerTokenUnreadableError);
  });
});

describe('the Coolify transport', () => {
  it('never sends the ciphertext as a bearer token', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { testServerConnection } = await import('@/lib/coolify/client.ts');
      const result = await testServerConnection({
        apiUrl: 'https://coolify.example.com',
        apiToken: ciphertext,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/encryption key/i);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
