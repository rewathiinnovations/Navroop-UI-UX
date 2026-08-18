const MIN_ENCRYPTION_KEY_BYTES = 32;

export function assertDistinctBuckets(
  appBucket = process.env.ELK_BUCKET || process.env.S3_BUCKET,
  backupBucket = process.env.BACKUP_BUCKET,
) {
  const app = appBucket?.trim();
  const backup = backupBucket?.trim();
  if (app && backup && app === backup) {
    throw new Error('BACKUP_BUCKET must be different from ELK_BUCKET');
  }
}

export function assertEncryptionKey(key = process.env.ENCRYPTION_KEY) {
  if (!key || Buffer.byteLength(key, 'utf8') < MIN_ENCRYPTION_KEY_BYTES) {
    throw new Error('ENCRYPTION_KEY must be set and at least 32 bytes');
  }
}

export function assertProductionBackupDriver(
  nodeEnv = process.env.NODE_ENV,
  driver: 's3' | 'local' = backupDriverFromEnv(),
) {
  if (nodeEnv === 'production' && driver === 'local') {
    throw new Error('Refusing production backup to local filesystem');
  }
}

export function backupDriverFromEnv(): 's3' | 'local' {
  const endpoint = process.env.BACKUP_ENDPOINT?.trim();
  const bucket = process.env.BACKUP_BUCKET?.trim();
  return endpoint && bucket ? 's3' : 'local';
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
