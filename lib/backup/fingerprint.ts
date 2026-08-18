import { createHash } from 'node:crypto';

/** First 8 hex chars of sha256. Never log or return the raw key. */
export function encryptionKeyFingerprint(key: string) {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}
