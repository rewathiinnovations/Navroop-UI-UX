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
const orphanScan = vi.hoisted(() => ({ scanOrphans: vi.fn(), loadOrphanReferences: vi.fn() }));
const db = vi.hoisted(() => ({
  checkpointFindMany: vi.fn(),
  checkpointFindFirst: vi.fn(),
  checkpointCount: vi.fn(),
  checkpointAggregate: vi.fn(),
  assetAggregate: vi.fn(),
  previewAggregate: vi.fn(),
  workspaceUpsert: vi.fn(),
  appSettingFindUnique: vi.fn(),
  appSettingUpsert: vi.fn(),
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

vi.mock('@/lib/backup/orphans', () => ({ scanOrphans: orphanScan.scanOrphans }));

vi.mock('@/lib/backup/orphan-references', () => ({
  loadOrphanReferences: orphanScan.loadOrphanReferences,
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    checkpoint: {
      findMany: db.checkpointFindMany,
      findFirst: db.checkpointFindFirst,
      count: db.checkpointCount,
      aggregate: db.checkpointAggregate,
    },
    projectAsset: { aggregate: db.assetAggregate },
    previewBuild: { aggregate: db.previewAggregate },
    workspace: { upsert: db.workspaceUpsert },
    appSetting: { findUnique: db.appSettingFindUnique, upsert: db.appSettingUpsert },
  },
}));

const { runStorageVerify, VERIFY_CHECKPOINT_LIMIT, VERIFY_HEAD_CONCURRENCY, VERIFY_CURSOR_KEY } =
  await import('@/lib/backup/verify.ts');

/** No unreferenced objects anywhere: the orphan pass is exercised in storage-orphans.test.ts. */
function noOrphans() {
  return {
    action: 'report' as const,
    graceDays: 14,
    scopes: [],
    totals: {
      scanned: 0,
      orphans: 0,
      orphanBytes: 0,
      reclaimable: 0,
      deleted: 0,
      deleteFailed: 0,
      reclaimedBytes: 0,
    },
    truncated: false,
  };
}
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
  orphanScan.scanOrphans.mockReset();
  orphanScan.loadOrphanReferences.mockReset();
  for (const mock of Object.values(db)) mock.mockReset();

  runs.start.mockResolvedValue({ id: 'bck_test', startedAt: new Date('2026-08-18T02:00:00.000Z') });
  runs.finish.mockResolvedValue({});
  storage.listKeys.mockResolvedValue(KEYS);
  // The default is a healthy bucket: present, and the bytes come back.
  storage.get.mockResolvedValue(Buffer.from('{"files":[]}'));
  orphanScan.loadOrphanReferences.mockResolvedValue(new Map());
  orphanScan.scanOrphans.mockResolvedValue(noOrphans());
  db.checkpointFindMany.mockResolvedValue(
    KEYS.map((snapshotKey, index) => ({ id: `cp_${index}`, snapshotKey, snapshotBytes: 1_024 })),
  );
  db.checkpointCount.mockResolvedValue(KEYS.length);
  // The read probe queries the newest row on its own, because the page follows an id cursor.
  db.checkpointFindFirst.mockResolvedValue({ snapshotKey: KEYS[0] });
  db.checkpointAggregate.mockResolvedValue({ _sum: { snapshotBytes: 3_072 } });
  db.assetAggregate.mockResolvedValue({ _sum: { sizeBytes: 0 } });
  db.previewAggregate.mockResolvedValue({ _sum: { totalBytes: 0 } });
  db.workspaceUpsert.mockResolvedValue({});
  db.appSettingFindUnique.mockResolvedValue(null);
  db.appSettingUpsert.mockResolvedValue({});
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

  it('stops issuing probes at the first failure instead of guessing about the rest', async () => {
    // The probes now run with bounded concurrency (F-782), so "stops at the first failure"
    // means no *new* probe is started once the bucket has refused — the ones already in
    // flight were paid for before the answer came back. The guarantee that matters is
    // unchanged and asserted above: nothing is reported missing on a refused HEAD.
    const many = Array.from(
      { length: VERIFY_HEAD_CONCURRENCY * 4 },
      (_unused, index) => `snapshots/p/cp_${index}.json.gz`,
    );
    db.checkpointFindMany.mockResolvedValue(
      many.map((snapshotKey, index) => ({ id: `cp_${index}`, snapshotKey })),
    );
    storage.exists.mockRejectedValue(accessDenied());

    const result = await runStorageVerify();

    expect(result.missing).toEqual([]);
    expect(storage.exists.mock.calls.length).toBeLessThanOrEqual(VERIFY_HEAD_CONCURRENCY);
    expect(storage.exists.mock.calls.length).toBeLessThan(many.length);
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

describe('runStorageVerify is bounded and resumable', () => {
  it('asks for one page and records where to resume when the page is full', async () => {
    const page = Array.from({ length: VERIFY_CHECKPOINT_LIMIT }, (_unused, index) => ({
      id: `cp_${index}`,
      snapshotKey: `snapshots/p/cp_${index}.json.gz`,
    }));
    db.checkpointFindMany.mockResolvedValue(page);
    db.checkpointCount.mockResolvedValue(VERIFY_CHECKPOINT_LIMIT * 3);
    storage.exists.mockResolvedValue(true);

    const result = await runStorageVerify();

    // Before this fix there was no `take` at all, so one run tried to HEAD every checkpoint
    // in the installation and the whole check silently stopped working as the product grew.
    expect(db.checkpointFindMany.mock.calls[0]?.[0]?.take).toBe(VERIFY_CHECKPOINT_LIMIT);
    expect(result.checked).toBe(VERIFY_CHECKPOINT_LIMIT);
    expect(result.totalSnapshots).toBe(VERIFY_CHECKPOINT_LIMIT * 3);
    expect(result.nextCursor).toBe(`cp_${VERIFY_CHECKPOINT_LIMIT - 1}`);
    expect(db.appSettingUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: VERIFY_CURSOR_KEY } }),
    );
    expect(db.appSettingUpsert.mock.calls[0]?.[0]?.update?.value).toBe(
      `cp_${VERIFY_CHECKPOINT_LIMIT - 1}`,
    );
    // The run says how far it got instead of failing wholesale.
    expect(result.ok).toBe(true);
  });

  it('continues after the stored cursor', async () => {
    db.appSettingFindUnique.mockResolvedValue({ value: 'cp_500' });
    storage.exists.mockResolvedValue(true);

    await runStorageVerify();

    expect(db.checkpointFindMany.mock.calls[0]?.[0]?.where?.id).toEqual({ gt: 'cp_500' });
  });

  it('clears the cursor at the tail so the next run sweeps from the start', async () => {
    db.appSettingFindUnique.mockResolvedValue({ value: 'cp_500' });
    storage.exists.mockResolvedValue(true);

    const result = await runStorageVerify();

    expect(result.nextCursor).toBe(null);
    expect(db.appSettingUpsert.mock.calls[0]?.[0]?.update?.value).toBe('');
  });
});

describe('runStorageVerify reconciles the storage ledger', () => {
  it('recomputes from aggregates over all three billed row types', async () => {
    storage.exists.mockResolvedValue(true);
    db.checkpointAggregate.mockResolvedValue({ _sum: { snapshotBytes: 1_000 } });
    db.assetAggregate.mockResolvedValue({ _sum: { sizeBytes: 200 } });
    db.previewAggregate.mockResolvedValue({ _sum: { totalBytes: 30 } });

    const result = await runStorageVerify();

    // Preview bytes are added to the ledger on upload, so a reconciliation that ignored them
    // subtracted every live preview from the number it claims to repair.
    expect(result.storageBytes).toBe(1_230);
    expect(db.workspaceUpsert.mock.calls[0]?.[0]?.update).toEqual({ storageBytes: 1_230 });
  });

  it('does not sum the page it happened to check', async () => {
    // Sizes came off the loaded rows before, which silently under-counted the moment the
    // page stopped being the whole table.
    db.checkpointFindMany.mockResolvedValue([{ id: 'cp_0', snapshotKey: KEYS[0] }]);
    db.checkpointAggregate.mockResolvedValue({ _sum: { snapshotBytes: 999_999 } });
    storage.exists.mockResolvedValue(true);

    const result = await runStorageVerify();

    expect(result.storageBytes).toBe(999_999);
  });
});

describe('runStorageVerify and unreferenced objects', () => {
  it('reports them without failing a run whose backups are intact', async () => {
    storage.exists.mockResolvedValue(true);
    orphanScan.scanOrphans.mockResolvedValue({
      ...noOrphans(),
      totals: { ...noOrphans().totals, orphans: 3, orphanBytes: 500, reclaimable: 2 },
    });

    const result = await runStorageVerify();

    expect(result.ok).toBe(true);
    expect(result.orphans?.totals.orphans).toBe(3);
  });

  it('warns when unreferenced objects are a material share of what is billed', async () => {
    storage.exists.mockResolvedValue(true);
    db.checkpointAggregate.mockResolvedValue({ _sum: { snapshotBytes: 1_000 } });
    orphanScan.scanOrphans.mockResolvedValue({
      ...noOrphans(),
      totals: { ...noOrphans().totals, orphans: 4, orphanBytes: 400, reclaimable: 4 },
    });

    const result = await runStorageVerify();

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Orphaned objects');
    // A successful run used to carry no detail at all, so this was invisible.
    expect(result.detail).toContain('grace period');
    expect(String(finishedWith().detail)).toContain('Orphaned objects');
  });

  it('keeps the orphan sample out of the run row when there are thousands', async () => {
    storage.exists.mockResolvedValue(true);
    orphanScan.scanOrphans.mockResolvedValue({
      ...noOrphans(),
      scopes: [
        {
          prefix: 'snapshots/',
          label: 'checkpoint snapshots',
          scanned: 5_000,
          orphans: 5_000,
          orphanBytes: 5_000,
          reclaimable: 0,
          sample: Array.from({ length: 5_000 }, (_unused, index) => `snapshots/p/x${index}`),
          deleted: 0,
          deleteFailed: 0,
          reclaimedBytes: 0,
        },
      ],
      totals: { ...noOrphans().totals, orphans: 5_000, orphanBytes: 5_000 },
    });

    await runStorageVerify();

    const detail = String(finishedWith().detail);
    // The whole array used to be serialised here: 5,000 keys is a multi-hundred-kilobyte
    // string written into Postgres every week.
    expect(detail.length).toBeLessThan(4_000);
    expect(detail).toContain('"total":5000');
  });
});
