import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createReadStream, createWriteStream, type ReadStream } from 'node:fs';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { backupDriverFromEnv } from './assert';
import type { RetentionObject } from './retention';

const PREFIX = 'backups/db/';

function requireBackupEnv(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`${names[0]} is required for backups`);
}

export function backupBucket() {
  return requireBackupEnv('BACKUP_BUCKET');
}

export function backupS3Client() {
  return new S3Client({
    region: process.env.BACKUP_REGION?.trim() || 'auto',
    endpoint: requireBackupEnv('BACKUP_ENDPOINT'),
    credentials: {
      accessKeyId: requireBackupEnv('BACKUP_ACCESS_KEY_ID'),
      secretAccessKey: requireBackupEnv('BACKUP_SECRET_ACCESS_KEY'),
    },
    forcePathStyle: true,
  });
}

function localBackupRoot() {
  return process.env.BACKUP_LOCAL_DIR || join(process.cwd(), 'tmp', 'backups');
}

/**
 * True only when `await import('@aws-sdk/lib-storage')` failed because the package is
 * absent. Every other error — a network failure, a rejected key, a half-finished
 * multipart upload — must propagate, because the single-PUT fallback is not a retry:
 * retrying an upload that already read from the body would store a truncated object.
 */
export function isMissingUploadHelper(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  return message.includes('Cannot find module') || message.includes('ERR_MODULE_NOT_FOUND');
}

export async function uploadBackupFile(localPath: string, objectKey: string, expectedBytes: number) {
  if (backupDriverFromEnv() === 'local') {
    const dest = join(localBackupRoot(), objectKey);
    await mkdir(dirname(dest), { recursive: true });
    await pipeline(createReadStream(localPath), createWriteStream(dest));
    const info = await stat(dest);
    if (info.size !== expectedBytes) {
      throw new Error(`Local backup size mismatch: expected ${expectedBytes}, got ${info.size}`);
    }
    return info.size;
  }

  const client = backupS3Client();
  const bucket = backupBucket();
  // One file handle per attempt. A stream can only be read once, so the fallback
  // needs its own; and a throw before the SDK drained it leaves the fd open.
  const bodies: ReadStream[] = [];
  const nextParams = () => {
    const body = createReadStream(localPath);
    bodies.push(body);
    return {
      Bucket: bucket,
      Key: objectKey,
      Body: body,
      ContentType: 'application/octet-stream',
    };
  };

  try {
    // Streamed upload (not a full buffer). Prefer @aws-sdk/lib-storage when installed.
    try {
      const { Upload } = await import('@aws-sdk/lib-storage');
      await new Upload({ client, params: nextParams() }).done();
    } catch (error) {
      if (!isMissingUploadHelper(error)) throw error;
      await client.send(new PutObjectCommand(nextParams()));
    }

    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
    const remote = head.ContentLength ?? -1;
    if (remote !== expectedBytes) {
      throw new Error(`HeadObject size mismatch: expected ${expectedBytes}, got ${remote}`);
    }
    return remote;
  } finally {
    for (const body of bodies) body.destroy();
    client.destroy();
  }
}

export type BackupListObject = RetentionObject & { sizeBytes: number };

export async function listBackupObjects(): Promise<BackupListObject[]> {
  if (backupDriverFromEnv() === 'local') {
    const root = join(localBackupRoot(), PREFIX);
    let names: string[] = [];
    try {
      names = await readdir(root);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return [];
      throw error;
    }
    const rows: BackupListObject[] = [];
    for (const name of names) {
      const info = await stat(join(root, name));
      rows.push({ key: `${PREFIX}${name}`, lastModified: info.mtime, sizeBytes: info.size });
    }
    return rows;
  }

  const client = backupS3Client();
  const bucket = backupBucket();
  try {
    const rows: BackupListObject[] = [];
    let token: string | undefined;
    do {
      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: PREFIX,
          ContinuationToken: token,
        }),
      );
      for (const object of response.Contents ?? []) {
        if (!object.Key || !object.LastModified) continue;
        rows.push({
          key: object.Key,
          lastModified: object.LastModified,
          sizeBytes: object.Size ?? 0,
        });
      }
      token = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (token);
    return rows;
  } finally {
    client.destroy();
  }
}

export async function deleteBackupObject(key: string) {
  if (backupDriverFromEnv() === 'local') {
    try {
      await unlink(join(localBackupRoot(), key));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
    }
    return;
  }
  // Called once per retained object in the retention loop, so the socket pool this
  // client owns has to be released rather than left for the garbage collector.
  const client = backupS3Client();
  try {
    await client.send(new DeleteObjectCommand({ Bucket: backupBucket(), Key: key }));
  } finally {
    client.destroy();
  }
}

export async function downloadBackupObject(key: string, destPath: string) {
  await mkdir(dirname(destPath), { recursive: true });
  if (backupDriverFromEnv() === 'local') {
    const { copyFile } = await import('node:fs/promises');
    await copyFile(join(localBackupRoot(), key), destPath);
    return;
  }
  const client = backupS3Client();
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: backupBucket(), Key: key }));
    const body = response.Body;
    if (!body) throw new Error(`Backup object missing: ${key}`);
    // Stream to disk. Buffering the whole dump would run out of memory on a large
    // database — exactly when a restore matters most. `pipeline` also destroys the
    // response stream if either side fails.
    if (body instanceof Readable) {
      await pipeline(body, createWriteStream(destPath));
      return;
    }
    const bytes = await body.transformToByteArray();
    await writeFile(destPath, Buffer.from(bytes));
  } finally {
    client.destroy();
  }
}

export function backupObjectPrefix() {
  return PREFIX;
}
