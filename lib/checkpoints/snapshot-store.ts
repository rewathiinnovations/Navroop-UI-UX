import { gzipSync, gunzipSync } from 'node:zlib';
import { get, upload } from '../storage/index.ts';

export type FileSnapshotEntry = { path: string; content: string };

export type SnapshotRecord = {
  snapshotKey?: string | null;
  fileSnapshot?: unknown;
};

export type WriteSnapshotResult = {
  snapshotKey: string;
  snapshotBytes: number;
  snapshotFileCount: number;
};

export function snapshotObjectKey(projectId: string, checkpointId: string) {
  return `snapshots/${projectId}/${checkpointId}.json.gz`;
}

export function asFileSnapshot(value: unknown): FileSnapshotEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as { path?: unknown; content?: unknown };
    if (typeof row.path !== 'string' || typeof row.content !== 'string') return [];
    return [{ path: row.path, content: row.content }];
  });
}

export async function writeSnapshot(
  projectId: string,
  checkpointId: string,
  files: FileSnapshotEntry[],
): Promise<WriteSnapshotResult> {
  const json = JSON.stringify(files);
  const beforeBytes = Buffer.byteLength(json, 'utf8');
  const gzip = gzipSync(Buffer.from(json, 'utf8'));
  const snapshotKey = snapshotObjectKey(projectId, checkpointId);
  console.debug('[checkpoints] snapshot gzip', {
    projectId,
    checkpointId,
    beforeBytes,
    afterBytes: gzip.length,
  });
  await upload(gzip, {
    key: snapshotKey,
    contentType: 'application/gzip',
  });
  return {
    snapshotKey,
    snapshotBytes: gzip.length,
    snapshotFileCount: files.length,
  };
}

export async function readSnapshot(record: SnapshotRecord): Promise<FileSnapshotEntry[]> {
  if (record.snapshotKey) {
    const body = await get(record.snapshotKey);
    if (body) {
      try {
        const json = gunzipSync(body).toString('utf8');
        return asFileSnapshot(JSON.parse(json));
      } catch (error) {
        console.warn('[checkpoints] snapshotKey gunzip failed, trying legacy', error);
      }
    }
  }
  return asFileSnapshot(record.fileSnapshot);
}
