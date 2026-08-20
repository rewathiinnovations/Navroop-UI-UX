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

/**
 * The (host, port, database) identity a PostgreSQL URL resolves to, or null when the URL
 * cannot be read. Postgres reaches the same database through many spellings — `postgres://`
 * vs `postgresql://`, an implicit vs explicit `:5432`, host case, a trailing slash, an
 * encoded database name — so the guard below compares this identity, never the URL text.
 */
function dbConnectionIdentity(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  // libpq accepts both spellings for the same server; anything else is not a target this
  // guard can vouch for.
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') return null;
  // Non-special schemes skip WHATWG host lowercasing, and DNS is case-insensitive.
  const host = parsed.hostname.toLowerCase();
  const port = parsed.port || '5432';
  let database: string;
  try {
    database = decodeURIComponent(parsed.pathname.replace(/\/+$/, '').replace(/^\//, ''));
  } catch {
    return null; // an undecodable database name is unreadable, not provably distinct
  }
  if (!host || !database) return null;
  return { host, port, database };
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
  const restore = dbConnectionIdentity(restoreUrl);
  const live = dbConnectionIdentity(databaseUrl);
  // Fail closed: a URL this guard cannot parse must refuse, because `pg_restore` may still
  // be able to reach the live database through it.
  if (!restore || !live) {
    throw new Error(
      'RESTORE_DATABASE_URL and DATABASE_URL must both be readable postgres:// URLs naming a host and a database; refusing to restore into a target this guard cannot identify',
    );
  }
  if (
    restore.host === live.host &&
    restore.port === live.port &&
    restore.database === live.database
  ) {
    throw new Error('RESTORE_DATABASE_URL must differ from DATABASE_URL');
  }
}
