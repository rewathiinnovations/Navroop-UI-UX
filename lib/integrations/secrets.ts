import { decrypt, encrypt } from '@/lib/crypto';
import type { IntegrationSecrets } from './types';

export function encryptSecretsBlob(secrets: IntegrationSecrets): string {
  return encrypt(JSON.stringify(secrets));
}

export function decryptSecretsBlob(blob: string | null | undefined): IntegrationSecrets {
  if (!blob) return {};
  try {
    const parsed = JSON.parse(decrypt(blob)) as IntegrationSecrets;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
