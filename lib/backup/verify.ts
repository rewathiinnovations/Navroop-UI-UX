import { prisma } from '@/lib/db';
import { exists, get } from '@/lib/storage';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { log } from '@/lib/logger';
import { loadOrphanReferences } from './orphan-references';
import { scanOrphans, type OrphanScanReport } from './orphans';
import { finishBackupRun, startBackupRun } from './runs';

/**
 * How many snapshots one run will HEAD, and how many HEADs are in flight at once.
 *
 * The loop used to load *every* unpruned checkpoint with no `take` and await one `exists` at a
 * time (F-782). At a few thousand checkpoints that is a few thousand sequential round trips
 * inside one weekly invocation, which exceeds the request timeout long before it finishes — so
 * the check quietly stopped being performed at exactly the scale where it starts to matter.
 * The cap plus the cursor below turn that into bounded progress: each run verifies a page and
 * records where it stopped, and the next run continues from there, wrapping to the start once
 * it reaches the end.
 */
export const VERIFY_CHECKPOINT_LIMIT = 1_000;
export const VERIFY_HEAD_CONCURRENCY = 8;

/** Keys named in `BackupRun.detail`. The full list stays in the return value. */
export const VERIFY_SAMPLE_LIMIT = 20;

/** Ad-hoc `AppSetting` row, namespaced away from `settings.*` and `cron.inflight.*`. */
export const VERIFY_CURSOR_KEY = 'backup.verifyCursor';

export type StorageVerifyDeps = {
  now?: Date;
  /** Injection seams; the defaults are the real thing. */
  scanOrphansImpl?: typeof scanOrphans;
  loadReferencesImpl?: typeof loadOrphanReferences;
};

type HeadDeps = { existsImpl: typeof exists; concurrency: number };

/**
 * HEADs `keys` with bounded concurrency and returns the ones genuinely absent.
 *
 * A rejected HEAD throws instead of counting as absent: presenting refused credentials or a
 * throttled window on /admin/backups as backup data loss invites a restore as the first
 * response to a credentials problem. The first rejection stops new work — the in-flight
 * probes are already paid for, and there is nothing to learn from issuing more once the
 * bucket has said no.
 */
async function findMissing(keys: string[], deps: HeadDeps) {
  const missing: string[] = [];
  let next = 0;
  let failure: Error | null = null;

  const worker = async () => {
    while (!failure) {
      const index = next;
      next += 1;
      if (index >= keys.length) return;
      const key = keys[index];
      if (!key) continue;
      try {
        if (!(await deps.existsImpl(key))) missing.push(key);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        failure ??= new Error(
          `Could not check snapshot storage (${key}): ${detail}. This is a storage failure, not missing data.`,
        );
        return;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(deps.concurrency, keys.length) }, () => worker()),
  );
  if (failure) throw failure;
  // Completion order is not probe order, and this list is compared between runs by operators.
  return missing.sort();
}

function orphanSummary(orphans: OrphanScanReport) {
  return {
    action: orphans.action,
    graceDays: orphans.graceDays,
    total: orphans.totals.orphans,
    bytes: orphans.totals.orphanBytes,
    reclaimable: orphans.totals.reclaimable,
    deleted: orphans.totals.deleted,
    deleteFailed: orphans.totals.deleteFailed,
    reclaimedBytes: orphans.totals.reclaimedBytes,
    truncated: orphans.truncated,
    byPrefix: orphans.scopes.map((scope) => ({
      prefix: scope.prefix,
      scanned: scope.scanned,
      orphans: scope.orphans,
      bytes: scope.orphanBytes,
      // Bounded on purpose: the whole array used to be serialised here, so a bucket with
      // thousands of orphans wrote a multi-megabyte string into Postgres every week (F-781).
      sample: scope.sample.slice(0, VERIFY_SAMPLE_LIMIT),
    })),
  };
}

export async function runStorageVerify(deps: StorageVerifyDeps = {}) {
  const run = await startBackupRun('storage_verify');
  const scan = deps.scanOrphansImpl ?? scanOrphans;
  const loadReferences = deps.loadReferencesImpl ?? loadOrphanReferences;
  try {
    const where = { snapshotKey: { not: null }, snapshotPruned: false } as const;
    const cursorRow = await prisma.appSetting.findUnique({
      where: { key: VERIFY_CURSOR_KEY },
      select: { value: true },
    });
    const cursor = cursorRow?.value || null;

    const [total, page] = await Promise.all([
      prisma.checkpoint.count({ where }),
      prisma.checkpoint.findMany({
        where: cursor ? { ...where, id: { gt: cursor } } : where,
        // Keyset pagination by primary key, not `createdAt desc`: it is the only ordering that
        // cannot skip or repeat a row while checkpoints are being created and pruned
        // underneath a multi-run sweep.
        orderBy: { id: 'asc' },
        take: VERIFY_CHECKPOINT_LIMIT,
        select: { id: true, snapshotKey: true },
      }),
    ]);

    const keys = page.map((row) => row.snapshotKey).filter((key): key is string => Boolean(key));
    const missing = await findMissing(keys, {
      existsImpl: exists,
      concurrency: VERIFY_HEAD_CONCURRENCY,
    });

    // A full page means there is more to come; a short page means the tail was reached, and
    // clearing the cursor sends the next run back to the beginning.
    const nextCursor =
      page.length === VERIFY_CHECKPOINT_LIMIT ? (page[page.length - 1]?.id ?? null) : null;
    await prisma.appSetting.upsert({
      where: { key: VERIFY_CURSOR_KEY },
      create: { key: VERIFY_CURSOR_KEY, value: nextCursor ?? '' },
      update: { value: nextCursor ?? '' },
    });

    // HeadObject only proves an entry exists in the bucket index. It answers 200 for an object
    // whose bytes cannot be fetched: a credential that grants HeadObject but not GetObject, an
    // object transitioned to an archive class, or a zero-length object left behind by a failed
    // upload. This job exists to answer "would a restore work", so once per run it actually
    // reads one snapshot — the newest, because that is the one a restore reaches for first.
    // It proves the bucket serves bytes; it does not validate snapshot contents. Read with its
    // own query rather than off the page above: the page follows the id cursor, so the newest
    // snapshot is only in it by luck.
    const unreadable: string[] = [];
    const newest = await prisma.checkpoint.findFirst({
      where,
      orderBy: { createdAt: 'desc' },
      select: { snapshotKey: true },
    });
    const probeKey = newest?.snapshotKey ?? null;
    if (probeKey && !missing.includes(probeKey)) {
      let body: Buffer | null;
      try {
        body = await get(probeKey);
      } catch (error) {
        // Same rule as the HEADs above: a refused read is a storage failure, and presenting it
        // as data loss on /admin/backups invites a restore as the response to a credentials
        // problem.
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Could not read snapshot storage (${probeKey}): ${detail}. This is a storage failure, not missing data.`,
        );
      }
      if (!body || body.length === 0) unreadable.push(probeKey);
    }

    const orphans = await scan({ now: deps.now, references: await loadReferences() });

    // Recomputed from rows, not from the page: this is also the reconciliation that repairs a
    // `Workspace.storageBytes` left over-counted by a purge that died between deleting a
    // project and adjusting the ledger (F-783). Preview bytes are included because
    // `lib/preview/production.ts` adds them on upload — leaving them out made this "fix"
    // silently subtract every live preview from the ledger it claims to reconcile.
    const [snapshotAgg, assetAgg, previewAgg] = await Promise.all([
      prisma.checkpoint.aggregate({ where, _sum: { snapshotBytes: true } }),
      prisma.projectAsset.aggregate({ _sum: { sizeBytes: true } }),
      prisma.previewBuild.aggregate({
        where: { storagePrefix: { not: null } },
        _sum: { totalBytes: true },
      }),
    ]);
    const storageBytes =
      (snapshotAgg._sum.snapshotBytes ?? 0) +
      (assetAgg._sum.sizeBytes ?? 0) +
      (previewAgg._sum.totalBytes ?? 0);

    await prisma.workspace.upsert({
      where: { id: WORKSPACE_ROW_ID },
      create: { id: WORKSPACE_ROW_ID, storageBytes },
      update: { storageBytes },
    });

    // `ok` stays a statement about restorability. Orphans are wasted money, not lost data, so
    // they are reported rather than allowed to turn this row red — a red row that means
    // "nothing is wrong with your backups" is how operators learn to ignore the red rows that
    // mean the other thing. The threshold below is what makes them visible anyway.
    const ok = missing.length === 0 && unreadable.length === 0;
    const warnings: string[] = [];
    if (orphans.totals.orphanBytes > 0 && orphans.totals.orphanBytes > storageBytes / 10) {
      warnings.push(
        `Orphaned objects account for ${orphans.totals.orphanBytes} bytes, more than a tenth of the ${storageBytes} bytes this installation is billed for. ${orphans.totals.reclaimable} are past the ${orphans.graceDays}-day grace period and can be reclaimed by setting Admin -> Configuration -> Storage -> Orphaned objects to Delete.`,
      );
    }
    if (orphans.totals.deleteFailed > 0) {
      warnings.push(
        `${orphans.totals.deleteFailed} orphaned object(s) could not be deleted and will be retried next run.`,
      );
    }
    for (const warning of warnings) log.warn('backup.storage_verify_warning', { warning });

    const detail = JSON.stringify({
      checked: keys.length,
      totalSnapshots: total,
      cursor: { from: cursor, next: nextCursor },
      missingCount: missing.length,
      missing: missing.slice(0, VERIFY_SAMPLE_LIMIT),
      unreadable,
      readProbe: probeKey,
      orphans: orphanSummary(orphans),
      storageBytes,
      warnings,
    });
    await finishBackupRun({
      id: run.id,
      status: ok ? 'success' : 'failed',
      detail,
      startedAt: run.startedAt,
    });
    return {
      ok,
      detail: ok
        ? warnings.join(' ') || null
        : `${missing.length} of ${keys.length} checked snapshots are missing and ${unreadable.length} could not be read`,
      missing,
      unreadable,
      orphans,
      storageBytes,
      checked: keys.length,
      totalSnapshots: total,
      nextCursor,
      warnings,
      runId: run.id,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Storage verify failed';
    await finishBackupRun({
      id: run.id,
      status: 'failed',
      detail: message,
      startedAt: run.startedAt,
    }).catch((writeError) => {
      // /admin/backups reads BackupRun — a lost failure row looks like "still running".
      console.error('[backup] could not record the failed verify run', writeError);
    });
    return {
      ok: false,
      detail: message,
      error: message,
      runId: run.id,
      missing: [] as string[],
      unreadable: [] as string[],
      orphans: null,
      warnings: [] as string[],
    };
  }
}
