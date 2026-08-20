import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';

/**
 * F-102: which checkpoint a project is *viewing*, as a column rather than client state.
 *
 * "Preview this version" used to write the old snapshot into `Project.lastCode` and mark the
 * fact in a `useState`. That made previewing a silent, unmarked rollback of the row the
 * product renders, publishes, exports and checkpoints from: one reload and the state saying
 * "this is temporary" was gone while the data stayed rolled back. A preview is now a read,
 * and this is the only thing that records it.
 *
 * Raw SQL on purpose, the same reason `lib/publish/repo-guard.ts` gives: the generated Prisma
 * client on a developer machine may predate the migration (regeneration is owned by the
 * dev-server agent, `single-dev-server.mdc`), and the guard has to be live either way.
 *
 * Every write is a guarded conditional UPDATE and the answer is the affected row count — the
 * `claimJobRun` discipline. Nothing re-reads the row to decide whether it won.
 */

/** Postgres `undefined_column`. */
const UNDEFINED_COLUMN = '42703';

/**
 * "The migration has not been applied here" versus "the query failed".
 *
 * Matched the way `isUndefinedTableError` in `lib/migrate/safety.ts` matches: Prisma wraps a
 * driver error from a raw query as `P2010` with the Postgres code in `meta.code`, a bare driver
 * error carries it on `code`, and the message check is the last resort. It names *this* column,
 * so an unrelated missing column can never be read as "no preview".
 */
function isMissingPreviewColumn(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { code?: unknown; meta?: { code?: unknown }; message?: unknown };
  const message = typeof record.message === 'string' ? record.message : '';
  const namesColumn = /previewingCheckpointId/i.test(message);
  if (!namesColumn) return false;
  return (
    record.code === UNDEFINED_COLUMN ||
    record.meta?.code === UNDEFINED_COLUMN ||
    /column .*previewingCheckpointId.* does not exist/i.test(message)
  );
}

export const PREVIEW_NOT_MIGRATED_MESSAGE =
  'Viewing an earlier version needs a database update that has not been applied to this environment yet. Nothing was changed.';

/**
 * The checkpoint this project is viewing, or null when it is on its current version.
 *
 * A database without the column is null rather than an error, and that is an implication
 * rather than a guess: with nowhere to record a preview, no preview can ever have been
 * recorded, so the live files *are* what this project is on. It is logged because an
 * environment running behind its own migrations is worth knowing about.
 */
export async function readPreviewingCheckpointId(projectId: string): Promise<string | null> {
  let rows: Array<{ previewingCheckpointId: string | null }>;
  try {
    rows = await prisma.$queryRaw<Array<{ previewingCheckpointId: string | null }>>`
      SELECT "previewingCheckpointId" FROM "Project" WHERE id = ${projectId} AND "deletedAt" IS NULL
    `;
  } catch (error) {
    if (isMissingPreviewColumn(error)) {
      log.warn('checkpoints.preview_column_missing', { projectId, path: 'read' });
      return null;
    }
    throw error;
  }
  const value = rows[0]?.previewingCheckpointId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Why a mark did not happen, so the caller can say which. Collapsing these was the habit that
 * produced most of this audit: `not-migrated` needs an operator, `no-such-project` needs
 * nothing, and reporting either as success promises a preview the read path will not serve.
 */
export type MarkPreviewResult = 'marked' | 'no-such-project' | 'not-migrated';

export async function markPreviewingCheckpoint(
  projectId: string,
  checkpointId: string,
): Promise<MarkPreviewResult> {
  let changed: number;
  try {
    changed = await prisma.$executeRaw`
      UPDATE "Project" SET "previewingCheckpointId" = ${checkpointId}
      WHERE id = ${projectId} AND "deletedAt" IS NULL
    `;
  } catch (error) {
    if (isMissingPreviewColumn(error)) {
      log.warn('checkpoints.preview_column_missing', { projectId, path: 'mark' });
      return 'not-migrated';
    }
    throw error;
  }
  return changed > 0 ? 'marked' : 'no-such-project';
}

/**
 * Returns the project to its current version.
 *
 * Unconditional on the previous value: exiting a preview claims only that the project is on
 * its current version afterwards, and that is true whether or not a preview was on — including
 * on a database with no column to hold one. The row count is still returned so a caller can
 * tell whether it also left a preview.
 */
export async function clearPreviewingCheckpoint(projectId: string): Promise<boolean> {
  try {
    const changed = await prisma.$executeRaw`
      UPDATE "Project" SET "previewingCheckpointId" = NULL
      WHERE id = ${projectId} AND "deletedAt" IS NULL AND "previewingCheckpointId" IS NOT NULL
    `;
    return changed > 0;
  } catch (error) {
    if (isMissingPreviewColumn(error)) {
      log.warn('checkpoints.preview_column_missing', { projectId, path: 'clear' });
      return false;
    }
    throw error;
  }
}
