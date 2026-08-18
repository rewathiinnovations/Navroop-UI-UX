/**
 * Object storage for project assets, avatars, and thumbnails.
 *
 * STORAGE_DRIVER=local (default, dev): writes under /public/uploads and returns a
 * relative URL. Fine for local preview; do not use for multi-instance production.
 *
 * STORAGE_DRIVER=s3: S3-compatible ElasticLake (path-style). The bucket must
 * allow public reads so asset URLs work in generated sites.
 *
 * Configured from Admin -> Configuration -> Storage. The legacy ELK_ and S3_
 * environment variables are still read when nothing is saved there, so an
 * existing deployment keeps working untouched.
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
import { getSetting, getSettings } from '@/lib/settings/resolve';
import { isObjectNotFoundError } from './s3-errors';

export type UploadInput = {
  key: string;
  contentType: string;
  contentEncoding?: string;
};

export type UploadResult = { url: string };

async function driver() {
  return (await getSetting('storage.driver')) === 's3' ? 's3' : 'local';
}

async function localRoot() {
  return (await getSetting('storage.localDir')) || join(process.cwd(), 'public', 'uploads');
}

function normalizeKey(key: string) {
  return key.replace(/^\/+/, '').replace(/\\/g, '/');
}

function localUrl(key: string) {
  return `/uploads/${normalizeKey(key)}`;
}

async function localUpload(buffer: Buffer, input: UploadInput): Promise<UploadResult> {
  const key = normalizeKey(input.key);
  const dest = join(await localRoot(), key);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buffer);
  return { url: localUrl(key) };
}

async function localExists(key: string) {
  try {
    await stat(join(await localRoot(), normalizeKey(key)));
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
    await unlink(join(await localRoot(), normalizeKey(key)));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
  }
}

function requireS3(value: string | null, label: string) {
  if (!value) {
    throw new Error(
      `${label} is required when storage is set to S3. Set it in Admin -> Configuration -> Storage.`,
    );
  }
  return value;
}

async function s3Bucket() {
  return requireS3(await getSetting('storage.s3.bucket'), 'S3 bucket');
}

async function s3Client() {
  const values = await getSettings([
    'storage.s3.region',
    'storage.s3.endpoint',
    'storage.s3.accessKeyId',
    'storage.s3.secretAccessKey',
  ]);
  return new S3Client({
    region: values['storage.s3.region'] || 'auto',
    endpoint: requireS3(values['storage.s3.endpoint'], 'S3 endpoint'),
    credentials: {
      accessKeyId: requireS3(values['storage.s3.accessKeyId'], 'S3 access key ID'),
      secretAccessKey: requireS3(values['storage.s3.secretAccessKey'], 'S3 secret access key'),
    },
    forcePathStyle: true,
  });
}

async function s3PublicUrl(key: string) {
  const base = requireS3(await getSetting('storage.s3.publicUrl'), 'S3 public URL').replace(
    /\/+$/,
    '',
  );
  return `${base}/${normalizeKey(key)}`;
}

async function s3Upload(buffer: Buffer, input: UploadInput): Promise<UploadResult> {
  const key = normalizeKey(input.key);
  await (await s3Client()).send(
    new PutObjectCommand({
      Bucket: await s3Bucket(),
      Key: key,
      Body: buffer,
      ContentType: input.contentType,
      ContentEncoding: input.contentEncoding,
    }),
  );
  return { url: await s3PublicUrl(key) };
}

async function s3Exists(key: string) {
  try {
    await (await s3Client()).send(
      new HeadObjectCommand({
        Bucket: await s3Bucket(),
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
  await (await s3Client()).send(
    new DeleteObjectCommand({
      Bucket: await s3Bucket(),
      Key: normalizeKey(key),
    }),
  );
}

export async function upload(buffer: Buffer, input: UploadInput): Promise<UploadResult> {
  if ((await driver()) === 's3') return s3Upload(buffer, input);
  return localUpload(buffer, input);
}

export async function exists(key: string) {
  if ((await driver()) === 's3') return s3Exists(key);
  return localExists(key);
}

export async function deleteObject(key: string) {
  if ((await driver()) === 's3') return s3Delete(key);
  return localDelete(key);
}

async function localGet(key: string): Promise<Buffer | null> {
  try {
    return await readFile(join(await localRoot(), normalizeKey(key)));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw error;
  }
}

async function s3Get(key: string): Promise<Buffer | null> {
  try {
    const response = await (await s3Client()).send(
      new GetObjectCommand({
        Bucket: await s3Bucket(),
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
  if ((await driver()) === 's3') return s3Get(key);
  return localGet(key);
}

async function localListKeys(prefix: string): Promise<string[]> {
  const root = await localRoot();
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
    const response = await (await s3Client()).send(
      new ListObjectsV2Command({
        Bucket: await s3Bucket(),
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
  if ((await driver()) === 's3') return s3ListKeys(prefix);
  return localListKeys(prefix);
}

/** Alias matching the adapter interface name `delete`. */
export { deleteObject as delete };

/** Trivial HEAD for /api/health. Local stats the uploads root; s3 lists one key. Throws on failure. */
export async function headStorage() {
  if ((await driver()) === 's3') {
    await (await s3Client()).send(
      new ListObjectsV2Command({
        Bucket: await s3Bucket(),
        MaxKeys: 1,
      }),
    );
    return true;
  }
  const root = await localRoot();
  try {
    await stat(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
    await mkdir(root, { recursive: true });
  }
  return true;
}
