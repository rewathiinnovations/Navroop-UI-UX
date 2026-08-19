import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `runStorageVerify` HEADs every checkpoint snapshot and marks the `BackupRun` failed when
 * any is missing. While `exists` swallowed errors, one rejected key or one throttled
 * window pushed every snapshot into `missing`, and `/admin/backups` showed the whole
 * backup set as gone — which invites a restore as the first response to what is really a
 * credentials problem.
 *
 * The run still fails on a storage failure; the difference is what it says. A genuinely
 * missing object is still named in `missing`, because that signal is the reason the job
 * exists and must not be softened.
 *
 * The run also reads one snapshot back. HeadObject only proves an entry exists in the bucket
 * index — it answers 200 for a credential that grants HeadObject but not GetObject, for an
 * object moved to an archive class, and for a zero-length object left by a failed upload — and
 * this job's whole claim is "a restore would work".
 *
 * Goes red if: a failed HEAD is counted as missing data again (the `missing` and detail
 * expectations fail); a genuinely absent snapshot stops being reported; or presence alone is
 * accepted as proof the bytes are there.
 */

const storage = vi.hoisted(() => ({ exists: vi.fn(), listKeys: vi.fn(), get: vi.fn() }));
const runs = vi.hoisted(() => ({ start: vi.fn(), finish: vi.fn() }));
const db = vi.hoisted(() => ({
  checkpointFindMany: vi.fn(),
  assetAggregate: vi.fn(),
  workspaceUpsert: vi.fn(),
}));

vi.mock('@/lib/storage', () => ({
  exists: storage.exists,
  listKeys: storage.listKeys,
  get: storage.get,
}));

vi.mock('@/lib/backup/runs', () => ({
  startBackupRun: runs.start,
  finishBackupRun: runs.finish,
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    checkpoint: { findMany: db.checkpointFindMany },
    projectAsset: { aggregate: db.assetAggregate },
    workspace: { upsert: db.workspaceUpsert },
  },
}));

const { runStorageVerify } = await import('@/lib/backup/verify.ts');

const KEYS = [
  'snapshots/proj_a/cp_1.json.gz',
  'snapshots/proj_b/cp_2.json.gz',
  'snapshots/proj_c/cp_3.json.gz',
];

function accessDenied() {
  return Object.assign(new Error('Access Denied'), {
    name: 'AccessDenied',
    $metadata: { httpStatusCode: 403 },
  });
}

function finishedWith(): { status?: string; detail?: string | null } {
  const call = runs.finish.mock.calls.at(-1);
  return (call?.[0] ?? {}) as { status?: string; detail?: string | null };
}

beforeEach(() => {
  storage.exists.mockReset();
  storage.listKeys.mockReset();
  storage.get.mockReset();
  runs.start.mockReset();
  runs.finish.mockReset();
  db.checkpointFindMany.mockReset();
  db.assetAggregate.mockReset();
  db.workspaceUpsert.mockReset();

  runs.start.mockResolvedValue({ id: 'bck_test', startedAt: new Date('2026-08-18T02:00:00.000Z') });
  runs.finish.mockResolvedValue({});
  storage.listKeys.mockResolvedValue(KEYS);
  // The default is a healthy bucket: present, and the bytes come back.
  storage.get.mockResolvedValue(Buffer.from('{"files":[]}'));
  db.checkpointFindMany.mockResolvedValue(
    KEYS.map((snapshotKey, index) => ({ id: `cp_${index}`, snapshotKey, snapshotBytes: 1_024 })),
  );
  db.assetAggregate.mockResolvedValue({ _sum: { sizeBytes: 0 } });
  db.workspaceUpsert.mockResolvedValue({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runStorageVerify when storage rejects the HEAD', () => {
  it('reports a storage failure rather than missing backup data', async () => {
    storage.exists.mockRejectedValue(accessDenied());

    const result = await runStorageVerify();

    expect(result.ok).toBe(false);
    // The point: no snapshot is accused of being gone.
    expect(result.missing).toEqual([]);
    const finished = finishedWith();
    expect(finished.status).toBe('failed');
    expect(finished.detail).toContain('storage failure, not missing data');
    expect(finished.detail).toContain('Access Denied');
  });

  it('control: the old loop would have listed every snapshot as missing', async () => {
    // The loop before the fix, over the same keys and the same error.
    const missing: string[] = [];
    for (const key of KEYS) {
      let ok: boolean;
      try {
        throw accessDenied();
      } catch {
        ok = false;
      }
      if (!ok) missing.push(key);
    }
    expect(missing).toEqual(KEYS);

    // The shipped code, same inputs.
    storage.exists.mockRejectedValue(accessDenied());
    const result = await runStorageVerify();
    expect(result.missing).toEqual([]);
    expect(result.missing).not.toEqual(KEYS);
  });

  it('stops at the first failure instead of guessing about the rest', async () => {
    storage.exists.mockRejectedValueOnce(accessDenied()).mockResolvedValue(true);
    await runStorageVerify();
    expect(storage.exists).toHaveBeenCalledTimes(1);
  });
});

describe('runStorageVerify when storage answers', () => {
  it('still names a snapshot that is genuinely gone', async () => {
    storage.exists.mockImplementation(async (key: string) => key !== KEYS[1]);

    const result = await runStorageVerify();

    expect(result.missing).toEqual([KEYS[1]]);
    expect(result.ok).toBe(false);
    expect(finishedWith().status).toBe('failed');
  });

  it('succeeds when every snapshot is present and the bytes come back', async () => {
    storage.exists.mockResolvedValue(true);

    const result = await runStorageVerify();

    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.unreadable).toEqual([]);
    expect(finishedWith().status).toBe('success');
    // Presence alone is not the claim being made: one object is actually read.
    expect(storage.get).toHaveBeenCalledTimes(1);
  });
});

describe('runStorageVerify when an object is present but not readable', () => {
  it('fails the run and names the object rather than reporting a healthy backup', async () => {
    storage.exists.mockResolvedValue(true);
    // HeadObject says 200, GetObject finds no body: a zero-length object from a failed upload,
    // or a key that lists but cannot be served.
    storage.get.mockResolvedValue(null);

    const result = await runStorageVerify();

    expect(result.ok).toBe(false);
    expect(result.unreadable).toEqual([KEYS[0]]);
    // Not `missing`: the object is there. Saying it is gone would invite a restore.
    expect(result.missing).toEqual([]);
    expect(finishedWith().status).toBe('failed');
    expect(String(finishedWith().detail)).toContain('unreadable');
  });

  it('treats a zero-length object as unreadable, because a snapshot never is', async () => {
    storage.exists.mockResolvedValue(true);
    storage.get.mockResolvedValue(Buffer.alloc(0));

    const result = await runStorageVerify();

    expect(result.ok).toBe(false);
    expect(result.unreadable).toEqual([KEYS[0]]);
  });

  it('reports a refused read as a storage failure, not as missing data', async () => {
    storage.exists.mockResolvedValue(true);
    storage.get.mockRejectedValue(accessDenied());

    const result = await runStorageVerify();

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([]);
    expect(result.unreadable).toEqual([]);
    const finished = finishedWith();
    expect(finished.status).toBe('failed');
    expect(finished.detail).toContain('storage failure, not missing data');
    expect(finished.detail).toContain('Access Denied');
  });

  it('does not read an object it already knows is gone', async () => {
    // One HEAD came back false, so the probe key is the one thing already proven absent;
    // GETting it would only turn a clear "missing" into a confusing "unreadable".
    storage.exists.mockImplementation(async (key: string) => key !== KEYS[0]);

    const result = await runStorageVerify();

    expect(result.missing).toEqual([KEYS[0]]);
    expect(storage.get).not.toHaveBeenCalled();
  });
});
