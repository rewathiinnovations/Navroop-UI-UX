import { decrypt, encrypt } from '@/lib/crypto';
import { log } from '@/lib/logger';
import type { IntegrationSecrets } from './types';

/**
 * What an operator is told when a stored credentials blob will not decrypt.
 *
 * Never the ciphertext, never the key — only the one action that fixes it. The wording
 * matters: this is not "not connected", and telling an admin to reconnect an integration
 * their own screen shows as connected is what made F-212 take a day to diagnose.
 */
export const SECRETS_UNREADABLE_MESSAGE =
  'The stored credentials cannot be read on this instance (encryption key mismatch). ' +
  'Restore the original ENCRYPTION_KEY, or reconnect this integration to store new credentials.';

export function encryptSecretsBlob(secrets: IntegrationSecrets): string {
  return encrypt(JSON.stringify(secrets));
}

export type SecretsRead = {
  secrets: IntegrationSecrets;
  /**
   * A blob is present but could not be decrypted or parsed. Distinct from an absent blob,
   * which is readable and empty. Callers must refuse to treat this row as usable rather
   * than fall through to "no credentials stored" (F-212).
   */
  unreadable: boolean;
};

const EMPTY: SecretsRead = { secrets: {}, unreadable: false };

/**
 * Reads a stored secrets blob, keeping "nothing stored" and "stored but unreadable" apart.
 *
 * The previous helper returned `{}` for both, so a rotated `ENCRYPTION_KEY` produced rows
 * that claimed CONNECTED and carried no credentials — the publish gate passed and the
 * failure surfaced mid-publish as the provider's own "not connected" error.
 */
export function readSecretsBlob(blob: string | null | undefined): SecretsRead {
  if (!blob) return EMPTY;
  let plaintext: string;
  try {
    plaintext = decrypt(blob);
  } catch (error) {
    // Key name and error only. The blob is credential material.
    log.error('integrations.secrets_undecryptable', {
      message: SECRETS_UNREADABLE_MESSAGE,
      error: error instanceof Error ? error.message : String(error),
    });
    return { secrets: {}, unreadable: true };
  }
  try {
    const parsed = JSON.parse(plaintext) as IntegrationSecrets;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      log.error('integrations.secrets_unparsable', {
        message: 'The stored credentials decrypted but are not an object.',
      });
      return { secrets: {}, unreadable: true };
    }
    return { secrets: parsed, unreadable: false };
  } catch (error) {
    log.error('integrations.secrets_unparsable', {
      message: 'The stored credentials decrypted but could not be parsed.',
      error: error instanceof Error ? error.message : String(error),
    });
    return { secrets: {}, unreadable: true };
  }
}
