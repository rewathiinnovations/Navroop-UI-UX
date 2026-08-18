import { getSettings } from '@/lib/settings/resolve';

const MIN_ENCRYPTION_KEY_BYTES = 32;

/**
 * The rule itself, with both values supplied. Kept pure and synchronous so it
 * stays directly testable; the wrapper below is what production calls.
 */
export function assertDistinctBucketValues(
  appBucket: string | null | undefined,
  backupBucket: string | null | undefined,
) {
  const app = appBucket?.trim();
  const backup = backupBucket?.trim();
  if (app && backup && app === backup) {
    throw new Error('The backup bucket must be different from the application storage bucket');
  }
}

export async function assertDistinctBuckets() {
  const values = await getSettings(['storage.s3.bucket', 'backups.bucket']);
  assertDistinctBucketValues(values['storage.s3.bucket'], values['backups.bucket']);
}

export function assertEncryptionKey(key = process.env.ENCRYPTION_KEY) {
  if (!key || Buffer.byteLength(key, 'utf8') < MIN_ENCRYPTION_KEY_BYTES) {
    throw new Error('ENCRYPTION_KEY must be set and at least 32 bytes');
  }
}

export function assertProductionBackupDriverValues(
  nodeEnv: string | undefined,
  driver: 's3' | 'local',
) {
  if (nodeEnv === 'production' && driver === 'local') {
    throw new Error('Refusing production backup to local filesystem');
  }
}

export async function assertProductionBackupDriver() {
  assertProductionBackupDriverValues(process.env.NODE_ENV, await backupDriver());
}

/** S3 only when both an endpoint and a bucket are configured; otherwise local disk. */
export async function backupDriver(): Promise<'s3' | 'local'> {
  const values = await getSettings(['backups.endpoint', 'backups.bucket']);
  return values['backups.endpoint'] && values['backups.bucket'] ? 's3' : 'local';
}

function normalizeDbUrl(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/+$/, '');
  } catch {
    return url.trim();
  }
}

export function assertRestoreTarget(
  databaseUrl = process.env.DATABASE_URL,
  restoreUrl = process.env.RESTORE_DATABASE_URL,
) {
  if (!restoreUrl?.trim()) {
    throw new Error('RESTORE_DATABASE_URL is required');
  }
  if (!databaseUrl?.trim()) {
    throw new Error('DATABASE_URL is required');
  }
  if (normalizeDbUrl(restoreUrl) === normalizeDbUrl(databaseUrl)) {
    throw new Error('RESTORE_DATABASE_URL must differ from DATABASE_URL');
  }
}
