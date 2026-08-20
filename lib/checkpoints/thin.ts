import { prisma } from '@/lib/db';
import { deleteObject } from '@/lib/storage';
import { adjustStorageBytes } from '@/lib/storage/usage';
import { checkpointRetentionDays, isThinEligible } from './retention';
import { pruneStalePresence } from '@/lib/projects/presence';
import { pruneAuditLogs } from '@/lib/audit/log';
import { prunePreviewBuilds } from '@/lib/preview/prune';
import { pruneObservabilityHistory } from '@/lib/observability/prune';
import { settleIdleProjects } from '@/lib/signals/collect';

/**
 * The daily maintenance cron. Thinning is only the first of six jobs it carries — presence,
 * audit log, preview build and observability retention plus the quality-signal settle pass
 * all hang off it — so no single failure inside it may take the others down with it.
 */
export async function thinCheckpoints() {
  const retentionDays = await checkpointRetentionDays();
  const now = new Date();
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  const latestRows = await prisma.checkpoint.groupBy({
    by: ['projectId'],
    _max: { createdAt: true },
  });
  const latestAt = new Map(
    latestRows.map((row) => [row.projectId, row._max.createdAt?.getTime() ?? 0]),
  );

  const candidates = await prisma.checkpoint.findMany({
    where: {
      isBookmarked: false,
      snapshotPruned: false,
      createdAt: { lt: cutoff },
      snapshotKey: { not: null },
    },
    select: {
      id: true,
      projectId: true,
      createdAt: true,
      isBookmarked: true,
      snapshotPruned: true,
      snapshotKey: true,
      snapshotBytes: true,
    },
  });

  let thinned = 0;
  let reclaimedBytes = 0;
  let blocked = 0;

  for (const row of candidates) {
    const latestCreatedAt = latestAt.get(row.projectId);
    const latestId = latestCreatedAt === row.createdAt.getTime() ? row.id : 'other';
    if (
      !isThinEligible({
        id: row.id,
        latestId,
        createdAt: row.createdAt,
        isBookmarked: row.isBookmarked,
        snapshotPruned: row.snapshotPruned,
        now,
        retentionDays,
      })
    ) {
      continue;
    }

    // `normalizeKey` throws on a stored key it cannot resolve (it used to silently rewrite),
    // and an S3 delete surfaces credential and throttle errors. Unguarded, one poisoned
    // `snapshotKey` aborted this entire cron on every run — no thinning, no presence pruning,
    // no audit pruning, no preview pruning — and the same row was re-selected every tick, so
    // it never self-healed. One bad key costs one snapshot. `prunePreviewBuilds` and
    // `purgeDeletedProjects` were both hardened this way; their caller was missed.
    //
    // The row keeps its `snapshotKey` on failure: that column is the only pointer to the
    // bytes, so clearing it would orphan them with nothing in the product naming them. A
    // retry is safe because deleting an already-deleted object is not an error.
    try {
      if (row.snapshotKey) {
        await deleteObject(row.snapshotKey);
      }
      await prisma.checkpoint.update({
        where: { id: row.id },
        data: { snapshotKey: null, snapshotPruned: true },
      });
      await adjustStorageBytes(-(row.snapshotBytes ?? 0));
    } catch (error) {
      blocked += 1;
      console.warn('[thin-checkpoints] snapshot could not be thinned, keeping the row', {
        checkpointId: row.id,
        snapshotKey: row.snapshotKey,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    thinned += 1;
    reclaimedBytes += row.snapshotBytes ?? 0;
  }

  // Each retention job is independent and each is the only thing that bounds its table or its
  // bucket prefix, so one failing must not skip the rest — that is how an unbounded `AuditLog`
  // and an unbounded preview prefix used to ride along behind a single bad snapshot key.
  const errors: string[] = [];
  const presence = await pruneStalePresence().catch((error: unknown) => {
    errors.push(`presence: ${error instanceof Error ? error.message : String(error)}`);
    return { pruned: 0 };
  });
  const audit = await pruneAuditLogs().catch((error: unknown) => {
    errors.push(`audit log: ${error instanceof Error ? error.message : String(error)}`);
    return { deleted: 0 };
  });
  const preview = await prunePreviewBuilds().catch((error: unknown) => {
    errors.push(`preview builds: ${error instanceof Error ? error.message : String(error)}`);
    return { deleted: 0, reclaimedBytes: 0 };
  });
  const observability = await pruneObservabilityHistory(now).catch((error: unknown) => {
    errors.push(`observability history: ${error instanceof Error ? error.message : String(error)}`);
    return { cronRuns: 0, checks: 0, cutoff: null as string | null };
  });
  // Maintenance, not a read: settling a project's follow-up count writes quality
  // signals. It used to run as the first statement of the /admin/quality render,
  // so a GET mutated data — twice if two admins opened the page (F-732).
  // `withSignalGuard` already swallows its own failures and returns null.
  const settled = await settleIdleProjects(now);
  if (settled == null) errors.push('quality signals: settle pass failed');

  const problems =
    blocked > 0
      ? [`${blocked} of ${candidates.length} snapshots could not be thinned`, ...errors]
      : errors;

  const report = {
    // Held-back snapshots and a skipped retention job both mean storage or a table is still
    // growing and only an operator can clear it, so the run must not read as healthy. This
    // cron is not in `CRON_STALE_MS`'s original set, which is why the abort above went
    // unnoticed until the volume filled.
    ok: problems.length === 0,
    detail: problems.length > 0 ? problems.join('; ') : null,
    thinned,
    blocked,
    reclaimedBytes,
    retentionDays,
    presencePruned: presence.pruned,
    auditPruned: audit.deleted,
    previewDeleted: preview.deleted,
    previewReclaimedBytes: preview.reclaimedBytes,
    cronRunsPruned: observability.cronRuns,
    observabilityChecksPruned: observability.checks,
    projectsSettled: settled ?? 0,
    errors,
  };
  console.info('[thin-checkpoints]', report);
  return report;
}
