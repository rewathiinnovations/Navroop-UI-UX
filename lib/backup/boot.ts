import { assertDistinctBuckets, assertEncryptionKey } from './assert';

/** Fail loudly on boot. Never logs ENCRYPTION_KEY or backup credentials. */
export function assertBackupBoot() {
  assertDistinctBuckets();
  if (process.env.NODE_ENV === 'production' || process.env.ENCRYPTION_KEY) {
    assertEncryptionKey();
  }
}
