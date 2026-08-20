import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * Versioned envelope prefix. Everything encrypted after 2026-08-20 carries it,
 * which is what makes "legacy plaintext", "legacy bare ciphertext" and
 * "encrypted under a key this instance no longer has" three distinguishable
 * states instead of one silent failure (D2, F-300/F-071).
 */
export const ENCRYPTION_PREFIX = 'enc:v1:';

/** Thrown when ENCRYPTION_KEY is unset. Named so callers can tell "no key" from "wrong key". */
export class EncryptionKeyMissingError extends Error {
  constructor() {
    super(
      'ENCRYPTION_KEY is not set. Stored secrets cannot be encrypted or decrypted without it — ' +
        'set ENCRYPTION_KEY (at least 32 bytes) in the environment and restart.',
    );
    this.name = 'EncryptionKeyMissingError';
  }
}

/**
 * ENCRYPTION_KEY only — deliberately no AUTH_SECRET/NEXTAUTH_SECRET fallback.
 * The fallback meant a dev or non-Docker install silently encrypted under
 * AUTH_SECRET, and adding ENCRYPTION_KEY later (as the docs instruct) made
 * every stored secret unreadable with no hint why (F-715). Production Docker
 * boot already enforces the variable (docker-entrypoint.mjs); tests provide it
 * via lib/verify/playwright-env.ts, the CI workflow env, or a per-suite pin —
 * that is the only sanctioned escape, and it still goes through this variable.
 */
function getKey() {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) {
    throw new EncryptionKeyMissingError();
  }
  return createHash('sha256').update(secret).digest();
}

/** True when the value carries the enc:v1 envelope this module writes. */
export function isEncrypted(value: string): boolean {
  return value.startsWith(ENCRYPTION_PREFIX);
}

/** AES-256-GCM. Payload is `enc:v1:` + base64(iv || authTag || ciphertext). */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENCRYPTION_PREFIX + Buffer.concat([iv, tag, encrypted]).toString('base64');
}

/**
 * Accepts both the prefixed enc:v1 form and the legacy bare-base64 form —
 * rows written before the envelope existed keep decrypting until a backfill
 * (scripts/encrypt-api-keys.ts) rewrites them.
 */
export function decrypt(payload: string): string {
  const body = isEncrypted(payload) ? payload.slice(ENCRYPTION_PREFIX.length) : payload;
  const buf = Buffer.from(body, 'base64');
  if (buf.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('Invalid ciphertext');
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const data = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
