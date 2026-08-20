import { decrypt, encrypt, isEncrypted } from '@/lib/crypto';

/**
 * Coolify server API tokens at rest.
 *
 * A leaf module on purpose: `servers.ts` imports the Coolify client and the client needs to
 * decrypt a token, so the pair cannot own this between them without a cycle.
 */

/**
 * Thrown when a stored token carries the `enc:v1:` envelope but will not decrypt on this
 * instance — a rotated `ENCRYPTION_KEY`, or a database dump restored elsewhere.
 *
 * It used to be swallowed. `decryptServerToken` returned the stored string on failure and the
 * transport *guessed* whether a value was encrypted by testing it for `==` or `length > 80`,
 * so the ciphertext went to Coolify as `Authorization: Bearer <ciphertext>` and every call
 * failed with an authentication error that said nothing about encryption — while
 * `/admin/servers` computed `last4` over the same ciphertext and presented it as the token's
 * (F-216). The envelope makes "encrypted" a fact rather than a guess, so a failure here has
 * exactly one cause and the operator gets told what it is.
 */
export class ServerTokenUnreadableError extends Error {
  constructor(cause?: unknown) {
    super(
      'The stored Coolify API token cannot be decrypted on this instance (encryption key mismatch). ' +
        'Restore the original ENCRYPTION_KEY, or re-enter the token at /admin/integrations.',
    );
    this.name = 'ServerTokenUnreadableError';
    this.cause = cause;
  }
}

export function encryptServerToken(token: string) {
  return encrypt(token);
}

/**
 * The plaintext token, or `ServerTokenUnreadableError`.
 *
 * An `enc:v1:` value must decrypt: there is no reading under which it is plaintext. A value
 * without the prefix predates the envelope, where bare-base64 ciphertext and genuine
 * plaintext are indistinguishable — so that one case, and only that one, still falls back to
 * the stored string. It is also the shape a caller passes when it holds an already-decrypted
 * token.
 */
export function decryptServerToken(stored: string) {
  const raw = stored.trim();
  if (isEncrypted(raw)) {
    try {
      return decrypt(raw);
    } catch (error) {
      throw new ServerTokenUnreadableError(error);
    }
  }
  try {
    return decrypt(raw);
  } catch {
    return raw;
  }
}
