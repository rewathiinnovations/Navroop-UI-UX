import { deleteObject, listObjects } from '@/lib/storage';
import type { StoredObject } from '@/lib/storage';
import { getSettings } from '@/lib/settings/resolve';
import { log } from '@/lib/logger';

/**
 * Objects in the bucket that nothing in the database points at.
 *
 * POLICY, deliberately recorded here rather than left implicit (F-781, F-172).
 *
 * Reporting is unconditional. Deleting is opt-in — `storage.orphanAction`, default
 * `report`. The classifier is only as good as its list of scopes: every prefix this product
 * writes needs an entry below *and* a way to rebuild what references it, and a writer added
 * later without both would make live files look abandoned. Reporting a false orphan costs a
 * puzzled operator; deleting one costs a customer their site. So the default is the cheap
 * mistake, `tests/unit/storage-orphans.test.ts` pins the scope list against the four key
 * builders in the repository, and an object under a prefix with no scope is never even listed.
 *
 * Deletion is also age-gated (`storage.orphanGraceDays`, default 14). Every writer here
 * uploads bytes seconds before committing the row that references them — see
 * `lib/checkpoints/actions.ts`, `lib/assets/persist.ts`, `lib/preview/build.ts` — so an
 * unreferenced object is only *certainly* abandoned once it is older than any in-flight write,
 * a failed upload's retry window, or a restore in progress. An object whose age the driver
 * could not report is never deleted at all.
 *
 * Both the reported sample and the number of deletes per run are capped. The first because
 * this ends up in `BackupRun.detail`, which used to take the entire unbounded array and write
 * a multi-megabyte string into Postgres; the second because the weekly cron has a request
 * timeout, and a bucket with a hundred thousand orphans has to make progress across several
 * runs instead of timing out on every one of them.
 */

/** How a scope's referenced objects are named by the database. */
export type OrphanScope = {
  prefix: string;
  /** Plain-language name used in operator-visible copy. */
  label: string;
  /**
   * `key`: rows store the exact object key. `prefix`: rows store a directory prefix and every
   * object under it is live (preview builds write one object per file of a built site).
   */
  match: 'key' | 'prefix';
};

export const ORPHAN_SCOPES: readonly OrphanScope[] = [
  { prefix: 'snapshots/', label: 'checkpoint snapshots', match: 'key' },
  { prefix: 'previews/', label: 'preview builds', match: 'prefix' },
  { prefix: 'projects/', label: 'project assets', match: 'key' },
  { prefix: 'users/', label: 'avatars', match: 'key' },
  { prefix: 'templates/', label: 'template thumbnails', match: 'key' },
];

export const ORPHAN_SAMPLE_LIMIT = 20;
export const ORPHAN_DELETE_LIMIT = 500;
export const ORPHAN_GRACE_DAYS_FALLBACK = 14;

export type OrphanReferences = { keys: Set<string>; prefixes: string[] };

export type OrphanScopeReport = {
  prefix: string;
  label: string;
  scanned: number;
  orphans: number;
  orphanBytes: number;
  /** Orphans past the grace period: what a `delete` action would remove. */
  reclaimable: number;
  sample: string[];
  deleted: number;
  deleteFailed: number;
  reclaimedBytes: number;
};

export type OrphanTotals = {
  scanned: number;
  orphans: number;
  orphanBytes: number;
  reclaimable: number;
  deleted: number;
  deleteFailed: number;
  reclaimedBytes: number;
};

export type OrphanAction = 'report' | 'delete';

export type OrphanScanReport = {
  action: OrphanAction;
  graceDays: number;
  scopes: OrphanScopeReport[];
  totals: OrphanTotals;
  /** True when reclaimable orphans were left for the next run because of the per-run cap. */
  truncated: boolean;
};

export type OrphanScanDeps = {
  now?: Date;
  references?: Map<string, OrphanReferences>;
  listObjectsImpl?: typeof listObjects;
  deleteObjectImpl?: typeof deleteObject;
  action?: OrphanAction;
  graceDays?: number;
};

/**
 * The storage key inside a stored public URL, or null when the URL does not name one.
 *
 * Two writers record a URL and not a key — `Checkpoint.thumbnailUrl` and `User.avatarUrl` —
 * and the URL shape depends on the driver (`/uploads/<key>` locally, `<publicUrl>/<key>` on
 * S3). Anchoring on the scope prefix recovers the key from either without hard-coding a base,
 * and returning null for anything unrecognised keeps an unknown URL from being treated as
 * evidence that some other object is live.
 */
export function storageKeyFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const withoutQuery = url.split(/[?#]/)[0] ?? '';
  for (const scope of ORPHAN_SCOPES) {
    const at = withoutQuery.indexOf(`/${scope.prefix}`);
    if (at >= 0) return withoutQuery.slice(at + 1);
    if (withoutQuery.startsWith(scope.prefix)) return withoutQuery;
  }
  return null;
}

function isReferenced(key: string, scope: OrphanScope, references: OrphanReferences) {
  if (references.keys.has(key)) return true;
  if (scope.match !== 'prefix') return false;
  return references.prefixes.some((prefix) => {
    const normalized = prefix.endsWith('/') ? prefix : `${prefix}/`;
    return key === prefix || key.startsWith(normalized);
  });
}

async function resolveAction(deps: OrphanScanDeps) {
  if (deps.action && deps.graceDays !== undefined) {
    return { action: deps.action, graceDays: deps.graceDays };
  }
  const values = await getSettings(['storage.orphanGraceDays', 'storage.orphanAction']);
  const parsed = Number(values['storage.orphanGraceDays']);
  return {
    action: deps.action ?? (values['storage.orphanAction'] === 'delete' ? 'delete' : 'report'),
    graceDays:
      deps.graceDays ??
      // A grace period of zero would defeat the whole safety argument above, so a blank,
      // unparseable or negative value falls back rather than being honoured.
      (Number.isFinite(parsed) && parsed >= 1 ? Math.trunc(parsed) : ORPHAN_GRACE_DAYS_FALLBACK),
  };
}

export async function scanOrphans(deps: OrphanScanDeps = {}): Promise<OrphanScanReport> {
  const now = deps.now ?? new Date();
  const list = deps.listObjectsImpl ?? listObjects;
  const remove = deps.deleteObjectImpl ?? deleteObject;
  const references = deps.references ?? new Map<string, OrphanReferences>();
  const { action, graceDays } = await resolveAction(deps);
  const graceMs = graceDays * 24 * 60 * 60 * 1000;

  const scopes: OrphanScopeReport[] = [];
  let deleteBudget = action === 'delete' ? ORPHAN_DELETE_LIMIT : 0;
  let truncated = false;

  for (const scope of ORPHAN_SCOPES) {
    const reference = references.get(scope.prefix) ?? { keys: new Set<string>(), prefixes: [] };
    const stored = await list(scope.prefix);
    const orphans: StoredObject[] = [];
    for (const object of stored) {
      if (!isReferenced(object.key, scope, reference)) orphans.push(object);
    }

    const reclaimable = orphans.filter(
      (object) => object.lastModified && now.getTime() - object.lastModified.getTime() > graceMs,
    );

    let deleted = 0;
    let deleteFailed = 0;
    let reclaimedBytes = 0;
    for (const object of reclaimable) {
      if (deleteBudget <= 0) {
        truncated = truncated || action === 'delete';
        break;
      }
      deleteBudget -= 1;
      try {
        await remove(object.key);
        deleted += 1;
        reclaimedBytes += object.sizeBytes;
      } catch (error) {
        // One poisoned or protected key must cost one object, not the pass — the same rule the
        // checkpoint and preview prunes already follow.
        deleteFailed += 1;
        log.warn('storage.orphan_delete_failed', {
          key: object.key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    scopes.push({
      prefix: scope.prefix,
      label: scope.label,
      scanned: stored.length,
      orphans: orphans.length,
      orphanBytes: orphans.reduce((sum, object) => sum + object.sizeBytes, 0),
      reclaimable: reclaimable.length,
      sample: orphans.slice(0, ORPHAN_SAMPLE_LIMIT).map((object) => object.key),
      deleted,
      deleteFailed,
      reclaimedBytes,
    });
  }

  const totals = scopes.reduce<OrphanTotals>(
    (sum, scope) => ({
      scanned: sum.scanned + scope.scanned,
      orphans: sum.orphans + scope.orphans,
      orphanBytes: sum.orphanBytes + scope.orphanBytes,
      reclaimable: sum.reclaimable + scope.reclaimable,
      deleted: sum.deleted + scope.deleted,
      deleteFailed: sum.deleteFailed + scope.deleteFailed,
      reclaimedBytes: sum.reclaimedBytes + scope.reclaimedBytes,
    }),
    {
      scanned: 0,
      orphans: 0,
      orphanBytes: 0,
      reclaimable: 0,
      deleted: 0,
      deleteFailed: 0,
      reclaimedBytes: 0,
    },
  );

  return { action, graceDays, scopes, totals, truncated };
}
