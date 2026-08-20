import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BackupAssert from '@/lib/backup/assert';
import type * as CronClaim from '@/lib/cron/claim';

/**
 * What a nightly backup is allowed to tell the operator.
 *
 * Two bugs lived here, both of which reported the opposite of the truth:
 *
 * 1. Retention ran inside the same `try` that owned the run's verdict, *after* the upload had
 *    already been proven good by the HeadObject size check. One 403 or timeout while deleting
 *    an already-expired object threw to the catch: the `BackupRun` was stored `failed`, every
 *    admin got a backup-failure email, and `latestSuccessfulDbBackup()` kept returning
 *    yesterday's run — so 48 hours later the stale-backup alert fired too. The operator was
 *    told they had no backup while a good one sat in the bucket.
 * 2. Every *successful* run called `notifyBackupAlert('restore_test', …)`. A `restore_test`
 *    BackupRun only exists after someone runs `scripts/restore-db.ts` against a separate
 *    RESTORE_DATABASE_URL, which a normal deploy does not set, so `isRestoreTestOverdue(null)`
 *    was permanently true: a red banner raised immediately after the previous one was cleared,
 *    plus mail to every admin, every night, forever, with no way to clear it from the product.
 *
 * Goes red if a durable backup is ever recorded `failed` for a housekeeping error, if an
 * advisory turns back into an alert email, if a retention failure becomes silent, if the
 * restore path stops refusing a database it was not aimed at, or if two backups can dump into
 * the same volume at once (F-722).
 */

const child = vi.hoisted(() => ({ exitCode: 0 }));
const fsp = vi.hoisted(() => ({ stat: vi.fn() }));
const dataDir = vi.hoisted(() => ({ assertFreeSpaceForLargeOp: vi.fn(), withTmpDir: vi.fn() }));
const alerts = vi.hoisted(() => ({
  clearBackupAlert: vi.fn(),
  notifyBackupAlert: vi.fn(),
  notifyStaleBackupIfNeeded: vi.fn(),
}));
const client = vi.hoisted(() => ({
  deleteBackupObject: vi.fn(),
  downloadBackupObject: vi.fn(),
  listBackupObjects: vi.fn(),
  uploadBackupFile: vi.fn(),
}));
const runs = vi.hoisted(() => ({
  start: vi.fn(),
  finish: vi.fn(),
  latestSuccess: vi.fn(),
  failStale: vi.fn(),
}));
/**
 * The in-flight claim `runDbBackup` takes. Held here rather than mocked per case so a test can
 * make the claim refuse, or hand back an abandoned holder, and still watch the release.
 */
const claims = vi.hoisted(() => ({
  release: vi.fn(),
  claimedAt: null as Date | null,
  outcome: null as unknown,
  store: {
    claim: vi.fn(),
  },
}));

vi.mock('node:child_process', () => ({
  spawn: () => {
    const handlers: Record<string, Array<(arg?: unknown) => void>> = {};
    const proc = {
      stderr: { on: () => undefined },
      on(event: string, fn: (arg?: unknown) => void) {
        (handlers[event] ??= []).push(fn);
        return proc;
      },
    };
    // pg_dump never runs in a unit test; the exit code is what `runCommand` reacts to.
    setImmediate(() => {
      for (const fn of handlers.close ?? []) fn(child.exitCode);
    });
    return proc;
  },
}));
vi.mock('node:fs/promises', () => ({ stat: fsp.stat }));
vi.mock('@/lib/runtime/data-dir', () => ({
  assertFreeSpaceForLargeOp: dataDir.assertFreeSpaceForLargeOp,
  withTmpDir: dataDir.withTmpDir,
}));
// `assertRestoreTarget` is deliberately the real implementation: the last describe in this file
// asserts that a restore refuses a target it was not aimed at, and a mocked guard would assert
// nothing. Only the two checks that need settings and a live bucket are stubbed.
vi.mock('@/lib/backup/assert', async (importOriginal) => ({
  ...(await importOriginal<typeof BackupAssert>()),
  assertDistinctBuckets: async () => undefined,
  assertProductionBackupDriver: async () => undefined,
  backupDriver: async () => 's3' as const,
}));
vi.mock('@/lib/backup/alerts', () => alerts);
vi.mock('@/lib/backup/client', () => ({
  backupObjectPrefix: () => 'backups/db/',
  deleteBackupObject: client.deleteBackupObject,
  downloadBackupObject: client.downloadBackupObject,
  listBackupObjects: client.listBackupObjects,
  uploadBackupFile: client.uploadBackupFile,
}));
vi.mock('@/lib/backup/runs', () => ({
  failStaleRunningBackupRuns: runs.failStale,
  finishBackupRun: runs.finish,
  latestSuccessfulDbBackup: runs.latestSuccess,
  startBackupRun: runs.start,
}));
// Only the store is replaced: `cronClaimStaleMs` stays real, so the window the settle pass
// uses is the one production uses.
vi.mock('@/lib/cron/claim', async (importOriginal) => ({
  ...(await importOriginal<typeof CronClaim>()),
  getCronClaimStore: () => claims.store,
}));

// Dynamic so the `vi.mock` factories above are installed before either module is evaluated; a
// static import would be hoisted past them and capture the real client, runs and alerts.
const { runDbBackup } = await import('@/lib/backup/db');
const { restoreDbBackup } = await import('@/lib/backup/restore');
const { cronClaimStaleMs, DB_BACKUP_CLAIM } = await import('@/lib/cron/claim');

const STARTED_AT = new Date('2026-08-19T02:00:00.000Z');

/**
 * More expired objects than the keep-newest floor, so the retention pass has something it is
 * actually allowed to delete — the newest `RETENTION_KEEP_NEWEST` survive regardless of age.
 */
const OBJECTS = [
  {
    key: 'backups/db/db-2024-01-04-aaaaaa.dump',
    lastModified: new Date('2024-01-04T02:00:00.000Z'),
    sizeBytes: 10,
  },
  {
    key: 'backups/db/db-2024-01-03-bbbbbb.dump',
    lastModified: new Date('2024-01-03T02:00:00.000Z'),
    sizeBytes: 10,
  },
  {
    key: 'backups/db/db-2024-01-02-cccccc.dump',
    lastModified: new Date('2024-01-02T02:00:00.000Z'),
    sizeBytes: 10,
  },
  {
    key: 'backups/db/db-2024-01-01-dddddd.dump',
    lastModified: new Date('2024-01-01T02:00:00.000Z'),
    sizeBytes: 10,
  },
];

function finishCalls() {
  return runs.finish.mock.calls.map(
    (call) => call[0] as { status?: string; detail?: string | null; sizeBytes?: number },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  child.exitCode = 0;
  process.env.DATABASE_URL ||= 'postgresql://u:p@127.0.0.1:5433/openlovable_test';
  fsp.stat.mockResolvedValue({ size: 4_096 });
  dataDir.assertFreeSpaceForLargeOp.mockReturnValue(undefined);
  dataDir.withTmpDir.mockImplementation(async (fn: (dir: string) => Promise<unknown>) =>
    fn('/data/tmp/backup-test'),
  );
  client.uploadBackupFile.mockResolvedValue(4_096);
  client.listBackupObjects.mockResolvedValue(OBJECTS);
  client.deleteBackupObject.mockResolvedValue(undefined);
  runs.start.mockResolvedValue({ id: 'bck_run', startedAt: STARTED_AT });
  runs.finish.mockResolvedValue({});
  // A run that just succeeded is never stale, so the healthy path clears the banner.
  runs.latestSuccess.mockResolvedValue({ startedAt: new Date() });
  runs.failStale.mockResolvedValue(0);
  claims.release.mockResolvedValue(undefined);
  claims.claimedAt = null;
  claims.store.claim.mockImplementation(async (name: string, now: Date) => {
    claims.claimedAt = now;
    return {
      claimed: true,
      abandoned: null,
      claim: { runId: `claim-${name}`, startedAt: now.toISOString(), release: claims.release },
    };
  });
});

describe('runDbBackup on a healthy night', () => {
  it('stores the backup, clears the banner, and raises no alert at all', async () => {
    const result = await runDbBackup();

    expect(result.ok).toBe(true);
    expect(result.objectKey).toMatch(/^backups\/db\/db-\d{4}-\d{2}-\d{2}-[0-9a-f]{6}\.dump$/);
    expect(result.sizeBytes).toBe(4_096);
    expect(finishCalls()).toEqual([
      expect.objectContaining({ status: 'success', sizeBytes: 4_096 }),
    ]);
    expect(alerts.clearBackupAlert).toHaveBeenCalledTimes(1);
    // The restore-test advisory belongs on /admin/backups, not in every admin's inbox.
    expect(alerts.notifyBackupAlert).not.toHaveBeenCalled();
  });
});

describe('runDbBackup when the retention pass fails', () => {
  beforeEach(() => {
    client.deleteBackupObject.mockRejectedValue(
      Object.assign(new Error('Access Denied'), { $metadata: { httpStatusCode: 403 } }),
    );
  });

  it('keeps the success receipt, because the object is durable', async () => {
    await runDbBackup();

    const statuses = finishCalls().map((call) => call.status);
    expect(statuses).not.toContain('failed');
    expect(statuses).toEqual(['success', 'success']);
    // Second write only appends the reason; the size and key are still recorded.
    expect(finishCalls()[1].detail).toContain('retention pass failed');
    expect(finishCalls()[1].sizeBytes).toBe(4_096);
  });

  it('does not email admins that the backup failed', async () => {
    await runDbBackup();
    expect(alerts.notifyBackupAlert).not.toHaveBeenCalled();
    // And the stale banner from a previous incident is still cleared: the operator's
    // /admin/backups must not keep claiming there is no backup.
    expect(alerts.clearBackupAlert).toHaveBeenCalledTimes(1);
  });

  it('still fails the cron run, so unbounded bucket growth is not silent', async () => {
    const result = await runDbBackup();

    expect(result.ok).toBe(false);
    expect(result.retentionError).toContain('Access Denied');
    // The detail says both halves, so the digest line cannot be read as a lost backup.
    expect(result.detail).toContain('backup stored');
    expect(result.detail).toContain('retention pass failed');
  });
});

describe('retention can never delete the dump this run just wrote (F-702)', () => {
  it('protects the just-written key even when the bucket lists everything as ancient', async () => {
    const uploaded = { key: '' };
    client.uploadBackupFile.mockImplementation(async (_path: string, key: string) => {
      uploaded.key = key;
      return 4_096;
    });
    // A skewed bucket clock (or restored objects) can report the fresh dump as ancient and
    // every other object as ancient too — the pass must still not eat its own dump.
    client.listBackupObjects.mockImplementation(async () => [
      { key: 'backups/db/decoy-1.dump', lastModified: new Date('2019-01-05T00:00:00.000Z') },
      { key: 'backups/db/decoy-2.dump', lastModified: new Date('2019-01-04T00:00:00.000Z') },
      { key: 'backups/db/decoy-3.dump', lastModified: new Date('2019-01-03T00:00:00.000Z') },
      { key: 'backups/db/decoy-4.dump', lastModified: new Date('2019-01-02T00:00:00.000Z') },
      { key: uploaded.key, lastModified: new Date('2019-01-01T00:00:00.000Z') },
    ]);

    const result = await runDbBackup();

    expect(result.ok).toBe(true);
    expect(uploaded.key).not.toBe('');
    const deletedKeys = client.deleteBackupObject.mock.calls.map((call) => call[0] as string);
    expect(deletedKeys).not.toContain(uploaded.key);
    // Objects past the newest-three floor are still shed; the floor is not "keep everything".
    expect(deletedKeys).toContain('backups/db/decoy-4.dump');
  });
});

describe('runDbBackup when the backup itself fails', () => {
  it('marks the run failed and alerts, on an upload that did not land', async () => {
    client.uploadBackupFile.mockRejectedValue(
      new Error('HeadObject size mismatch: expected 4096, got 0'),
    );

    const result = await runDbBackup();

    expect(result.ok).toBe(false);
    expect(finishCalls()).toEqual([
      expect.objectContaining({
        status: 'failed',
        detail: expect.stringContaining('size mismatch'),
      }),
    ]);
    expect(alerts.notifyBackupAlert).toHaveBeenCalledWith(
      'failed',
      expect.stringContaining('size mismatch'),
    );
    // Retention never runs on a failed backup: there may be nothing newer to age the old
    // objects out against.
    expect(client.deleteBackupObject).not.toHaveBeenCalled();
  });

  it('marks the run failed when pg_dump exits non-zero', async () => {
    child.exitCode = 1;

    const result = await runDbBackup();

    expect(result.ok).toBe(false);
    expect(finishCalls()[0].status).toBe('failed');
    expect(client.uploadBackupFile).not.toHaveBeenCalled();
  });
});

/**
 * F-722. `latestRunningDbBackup()` existed and `/admin/backups` rendered it, but nothing read
 * it before starting work: the 02:00 cron overlapping an operator's "Back up now" put two
 * `pg_dump`s into `/data/tmp` at once — on the volume the 2 GB precondition exists to protect
 * — and a killed run left a `running` row that nothing ever settled, so the admin screen
 * showed a backup in progress forever and the button stayed disabled.
 */
describe('runDbBackup while another backup holds the claim', () => {
  beforeEach(() => {
    claims.store.claim.mockResolvedValue({
      claimed: false,
      runningSince: '2026-08-19T01:58:00.000Z',
    });
  });

  it('refuses without dumping, uploading, or opening a second run row', async () => {
    const result = await runDbBackup();

    expect(result.ok).toBe(false);
    expect(result.alreadyRunning).toBe(true);
    expect(result.error).toContain('2026-08-19T01:58:00.000Z');
    expect(runs.start).not.toHaveBeenCalled();
    expect(dataDir.withTmpDir).not.toHaveBeenCalled();
    expect(client.uploadBackupFile).not.toHaveBeenCalled();
  });

  it('does not email admins: a backup that is already running has not failed', async () => {
    await runDbBackup();
    expect(alerts.notifyBackupAlert).not.toHaveBeenCalled();
    expect(runs.finish).not.toHaveBeenCalled();
  });

  it('claims under one name for every entry point, so cron and the admin button collide', () => {
    expect(claims.store.claim).not.toHaveBeenCalled();
    // The cron route's own `handleCron('backup-db')` claim cannot serialise the admin button
    // or `tsx scripts/backup-db.ts`, which never reach it — hence a claim on the operation.
    expect(DB_BACKUP_CLAIM).not.toBe('backup-db');
    expect(cronClaimStaleMs(DB_BACKUP_CLAIM)).toBe(cronClaimStaleMs('backup-db'));
  });
});

describe('runDbBackup after a killed run', () => {
  it('settles the rows the dead process left running, then backs up', async () => {
    claims.store.claim.mockImplementation(async (name: string, now: Date) => {
      claims.claimedAt = now;
      return {
        claimed: true,
        abandoned: { runId: 'dead', startedAt: '2026-08-19T02:00:00.000Z', ageMs: 7_200_000 },
        claim: { runId: `claim-${name}`, startedAt: now.toISOString(), release: claims.release },
      };
    });

    const result = await runDbBackup();

    expect(result.ok).toBe(true);
    expect(runs.failStale).toHaveBeenCalledTimes(1);
    const settle = runs.failStale.mock.calls[0][0] as {
      kind: string;
      startedBefore: Date;
      detail: string;
    };
    expect(settle.kind).toBe('db');
    expect(settle.startedBefore.getTime()).toBe(
      (claims.claimedAt as Date).getTime() - cronClaimStaleMs(DB_BACKUP_CLAIM),
    );
    expect(settle.detail).toMatch(/did not (finish|record)/i);
    // The settle pass runs before a new row is opened, so it can never catch this run.
    expect(runs.failStale.mock.invocationCallOrder[0]).toBeLessThan(
      runs.start.mock.invocationCallOrder[0],
    );
  });

  it('settles a row abandoned by a lost failure write even when no claim was left behind', async () => {
    await runDbBackup();
    // `finishBackupRun` failing is logged, not thrown, so a row can be stranded `running`
    // with the claim cleanly released. Only an unconditional settle recovers that one.
    expect(runs.failStale).toHaveBeenCalledTimes(1);
  });

  it('releases the claim even when the dump fails, so the next run is not locked out', async () => {
    child.exitCode = 1;
    await runDbBackup();
    expect(claims.release).toHaveBeenCalledTimes(1);
  });

  it('releases the claim on a healthy run', async () => {
    await runDbBackup();
    expect(claims.release).toHaveBeenCalledTimes(1);
  });
});

/**
 * The other half of the backup story: `scripts/restore-db.ts` runs `pg_restore` against
 * whatever `RESTORE_DATABASE_URL` names, and a restore into the live database is not something
 * an operator can undo. `assertRestoreTarget` is the only thing standing between a mistyped
 * env file and the production data, and it has to fire *before* any work starts — a refusal
 * that arrives after the dump has been downloaded and `pg_restore` has begun is not a refusal.
 */
describe('restoreDbBackup on a target it was not aimed at', () => {
  const KEY = 'backups/db/db-2026-08-19-abcdef.dump';

  // Both variables are process-wide, and other suites in this worker read DATABASE_URL, so the
  // originals go back afterwards rather than leaking a fake production URL sideways.
  const original = { db: process.env.DATABASE_URL, restore: process.env.RESTORE_DATABASE_URL };

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://navroop:secret@postgres:5432/navroop';
  });

  afterEach(() => {
    if (original.db === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original.db;
    if (original.restore === undefined) delete process.env.RESTORE_DATABASE_URL;
    else process.env.RESTORE_DATABASE_URL = original.restore;
  });

  it('refuses when RESTORE_DATABASE_URL is unset, rather than defaulting to DATABASE_URL', async () => {
    delete process.env.RESTORE_DATABASE_URL;

    await expect(restoreDbBackup(KEY)).rejects.toThrow('RESTORE_DATABASE_URL is required');
    // Nothing was touched: no run row to explain, no bytes fetched, no pg_restore.
    expect(runs.start).not.toHaveBeenCalled();
    expect(client.downloadBackupObject).not.toHaveBeenCalled();
  });

  it('refuses a RESTORE_DATABASE_URL that resolves to the live database', async () => {
    // Same database reached by a different spelling — the guard normalizes both sides, so a
    // trailing slash or an added query parameter must not get past it.
    process.env.RESTORE_DATABASE_URL =
      'postgresql://navroop:secret@postgres:5432/navroop?schema=public';

    await expect(restoreDbBackup(KEY)).rejects.toThrow('must differ from DATABASE_URL');
    expect(runs.start).not.toHaveBeenCalled();
    expect(client.downloadBackupObject).not.toHaveBeenCalled();
  });

  it('accepts a genuinely separate database and only then starts a run', async () => {
    process.env.RESTORE_DATABASE_URL = 'postgresql://navroop:secret@postgres:5432/navroop_restore';
    // The download is what a real restore does next; failing it here keeps pg_restore out of a
    // unit test while still proving the guard let the work begin.
    client.downloadBackupObject.mockRejectedValue(new Error('NoSuchKey'));

    const result = await restoreDbBackup(KEY);

    expect(result.ok).toBe(false);
    expect(runs.start).toHaveBeenCalledWith('restore_test');
    expect(finishCalls()[0]).toMatchObject({ status: 'failed', detail: 'NoSuchKey' });
  });
});
