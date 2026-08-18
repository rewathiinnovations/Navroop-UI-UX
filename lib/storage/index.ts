/**
 * Object storage for project assets, avatars, and thumbnails.
 *
 * STORAGE_DRIVER=local (default, dev): writes under /public/uploads and returns a
 * relative URL. Fine for local preview; do not use for multi-instance production.
 *
 * STORAGE_DRIVER=s3: S3-compatible ElasticLake (path-style). The bucket must
 * allow public reads so asset URLs work in generated sites.
 *
 * Env for s3: ELK_ENDPOINT, ELK_REGION, ELK_ACCESS_KEY_ID, ELK_SECRET_ACCESS_KEY,
 * ELK_BUCKET, S3_PUBLIC_URL. Legacy S3_* names are accepted as fallback.
 *
 * Key convention: projects/{projectId}/assets/{id}.{ext}
 * Checkpoint snapshots: snapshots/{projectId}/{checkpointId}.json.gz
 *
 * Contract for both drivers: `get` returns null and `exists` returns false ONLY for an
 * object that is genuinely absent. Every other failure throws. Callers turn an absent
 * snapshot into "this version was pruned" and an absent preview file into a 404, so a
 * driver that swallows a credentials or throttling error makes them answer wrongly and
 * silently. See lib/storage/s3-errors.ts.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { isObjectNotFoundError } from './s3-errors';

export type UploadInput = {
  key: string;
  contentType: string;
  contentEncoding?: string;
};

export type UploadResult = { url: string };

function driver() {
  return process.env.STORAGE_DRIVER === 's3' ? 's3' : 'local';
}

function localRoot() {
  return process.env.STORAGE_LOCAL_DIR || join(process.cwd(), 'public', 'uploads');
}

function normalizeKey(key: string) {
  return key.replace(/^\/+/, '').replace(/\\/g, '/');
}

function localUrl(key: string) {
  return `/uploads/${normalizeKey(key)}`;
}

async function localUpload(buffer: Buffer, input: UploadInput): Promise<UploadResult> {
  const key = normalizeKey(input.key);
  const dest = join(localRoot(), key);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buffer);
  return { url: localUrl(key) };
}

async function localExists(key: string) {
  try {
    await stat(join(localRoot(), normalizeKey(key)));
    return true;
  } catch (error) {
    // ENOTDIR: a path component is a file, so nothing can be stored under it. Anything
    // else (EACCES, EIO) means we could not look — that is not "absent".
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

async function localDelete(key: string) {
  try {
    await unlink(join(localRoot(), normalizeKey(key)));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
  }
}

function requireS3Env(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`${names[0]} is required when STORAGE_DRIVER=s3`);
}

function s3Bucket() {
  return requireS3Env('ELK_BUCKET', 'S3_BUCKET');
}

function s3Client() {
  return new S3Client({
    region: process.env.ELK_REGION?.trim() || process.env.S3_REGION?.trim() || 'auto',
    endpoint: requireS3Env('ELK_ENDPOINT', 'S3_ENDPOINT'),
    credentials: {
      accessKeyId: requireS3Env('ELK_ACCESS_KEY_ID', 'S3_ACCESS_KEY_ID'),
      secretAccessKey: requireS3Env('ELK_SECRET_ACCESS_KEY', 'S3_SECRET_ACCESS_KEY'),
    },
    forcePathStyle: true,
  });
}

function s3PublicUrl(key: string) {
  const base = requireS3Env('S3_PUBLIC_URL', 'ELK_PUBLIC_URL').replace(/\/+$/, '');
  return `${base}/${normalizeKey(key)}`;
}

async function s3Upload(buffer: Buffer, input: UploadInput): Promise<UploadResult> {
  const key = normalizeKey(input.key);
  await s3Client().send(
    new PutObjectCommand({
      Bucket: s3Bucket(),
      Key: key,
      Body: buffer,
      ContentType: input.contentType,
      ContentEncoding: input.contentEncoding,
    }),
  );
  return { url: s3PublicUrl(key) };
}

async function s3Exists(key: string) {
  try {
    await s3Client().send(
      new HeadObjectCommand({
        Bucket: s3Bucket(),
        Key: normalizeKey(key),
      }),
    );
    return true;
  } catch (error) {
    if (isObjectNotFoundError(error)) return false;
    throw error;
  }
}

async function s3Delete(key: string) {
  await s3Client().send(
    new DeleteObjectCommand({
      Bucket: s3Bucket(),
      Key: normalizeKey(key),
    }),
  );
}

export async function upload(buffer: Buffer, input: UploadInput): Promise<UploadResult> {
  if (driver() === 's3') return s3Upload(buffer, input);
  return localUpload(buffer, input);
}

export async function exists(key: string) {
  if (driver() === 's3') return s3Exists(key);
  return localExists(key);
}

export async function deleteObject(key: string) {
  if (driver() === 's3') return s3Delete(key);
  return localDelete(key);
}

async function localGet(key: string): Promise<Buffer | null> {
  try {
    return await readFile(join(localRoot(), normalizeKey(key)));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw error;
  }
}

async function s3Get(key: string): Promise<Buffer | null> {
  try {
    const response = await s3Client().send(
      new GetObjectCommand({
        Bucket: s3Bucket(),
        Key: normalizeKey(key),
      }),
    );
    if (!response.Body) return null;
    const bytes = await response.Body.transformToByteArray();
    return Buffer.from(bytes);
  } catch (error) {
    if (isObjectNotFoundError(error)) return null;
    throw error;
  }
}

export async function get(key: string): Promise<Buffer | null> {
  if (driver() === 's3') return s3Get(key);
  return localGet(key);
}

async function localListKeys(prefix: string): Promise<string[]> {
  const root = localRoot();
  const start = join(root, normalizeKey(prefix));
  const keys: string[] = [];

  async function walk(dir: string) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      keys.push(relative(root, full).split(sep).join('/'));
    }
  }

  await walk(start);
  return keys;
}

async function s3ListKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const response = await s3Client().send(
      new ListObjectsV2Command({
        Bucket: s3Bucket(),
        Prefix: normalizeKey(prefix),
        ContinuationToken: token,
      }),
    );
    for (const object of response.Contents ?? []) {
      if (object.Key) keys.push(object.Key);
    }
    token = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

export async function listKeys(prefix: string) {
  if (driver() === 's3') return s3ListKeys(prefix);
  return localListKeys(prefix);
}

/** Alias matching the adapter interface name `delete`. */
export { deleteObject as delete };

/** Trivial HEAD for /api/health. Local stats the uploads root; s3 lists one key. Throws on failure. */
export async function headStorage() {
  if (driver() === 's3') {
    await s3Client().send(
      new ListObjectsV2Command({
        Bucket: s3Bucket(),
        MaxKeys: 1,
      }),
    );
    return true;
  }
  const root = localRoot();
  try {
    await stat(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
    await mkdir(root, { recursive: true });
  }
  return true;
}
