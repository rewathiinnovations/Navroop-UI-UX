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

/**
 * The snapshot object exists as far as the database is concerned, but we could not read
 * it. Distinct from an empty snapshot: `fileSnapshot` is legacy-read-only and null for
 * every checkpoint written since the object-storage migration, so "read failed" used to
 * arrive at each caller as an empty array and became five different wrong answers —
 * a sandbox booted from stale `lastCode`, a stale published site, "your version is
 * gone", an empty ZIP, and dedupe that never fires.
 */
export class SnapshotReadError extends Error {
  readonly snapshotKey: string;

  constructor(snapshotKey: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Could not read checkpoint snapshot ${snapshotKey} from storage: ${detail}`, { cause });
    this.name = 'SnapshotReadError';
    this.snapshotKey = snapshotKey;
  }
}

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

/**
 * Files for a checkpoint. An empty array means the checkpoint is genuinely empty (or
 * pruned); it never means "we could not find out" — that throws `SnapshotReadError`.
 */
export async function readSnapshot(record: SnapshotRecord): Promise<FileSnapshotEntry[]> {
  if (record.snapshotKey) {
    let body: Buffer | null;
    try {
      body = await get(record.snapshotKey);
    } catch (error) {
      // `get` returns null for an object that is genuinely gone, so anything thrown
      // here means storage failed and we do not know what this checkpoint holds.
      throw new SnapshotReadError(record.snapshotKey, error);
    }
    if (body) {
      try {
        const json = gunzipSync(body).toString('utf8');
        return asFileSnapshot(JSON.parse(json));
      } catch (error) {
        // A snapshot written before the migration may still carry legacy Json.
        const legacy = asFileSnapshot(record.fileSnapshot);
        if (legacy.length > 0) {
          console.warn('[checkpoints] snapshotKey gunzip failed, using legacy fileSnapshot', error);
          return legacy;
        }
        // Otherwise the object is damaged. Reporting zero files would read as pruned.
        throw new SnapshotReadError(record.snapshotKey, error);
      }
    }
  }
  return asFileSnapshot(record.fileSnapshot);
}
