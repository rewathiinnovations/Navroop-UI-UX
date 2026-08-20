import { prisma } from '@/lib/db';

/** Single-row Workspace ledger. See prisma Workspace model. */
export const WORKSPACE_ROW_ID = 'default';

/**
 * The largest value `Workspace.storageBytes` can hold: it is a Postgres `INTEGER`,
 * so ~2.0 GiB (F-315).
 *
 * The seeded Pro plan sets `storageBytesLimit` (a `BigInt` column) to 20 GiB — an
 * order of magnitude above what the counter can represent — so the accumulating
 * increment errored with "integer out of range" long before the plan limit was
 * reached, and the limit could never be enforced on the plans that need it.
 * `planLimit('storage')` therefore clamps to this value, which turns an overflow
 * into an ordinary refusal.
 *
 * The migration that lifts it widens `Workspace.storageBytes` and
 * `Workspace.storageLimitBytes` to `BigInt` (and, for very large single objects,
 * `PreviewBuild.totalBytes` and `Checkpoint.snapshotBytes`). Until then this is
 * the real ceiling and it is better stated than discovered.
 */
export const MAX_TRACKABLE_STORAGE_BYTES = 2_147_483_647;

/**
 * The `Workspace` writes this helper needs. Narrow on purpose: it makes a Prisma transaction
 * client structurally assignable, so a caller that must not lose the adjustment if its own
 * write fails can pass its transaction in (`lib/projects/purge-deleted.ts`, F-783).
 */
export type StorageLedgerClient = {
  workspace: {
    upsert(args: {
      where: { id: string };
      create: { id: string; storageBytes: number };
      update: Record<string, unknown>;
    }): Promise<unknown>;
    updateMany(args: {
      where: { id: string; storageBytes: { lt: number } };
      data: { storageBytes: number };
    }): Promise<unknown>;
  };
};

export async function getWorkspaceStorage() {
  return prisma.workspace.upsert({
    where: { id: WORKSPACE_ROW_ID },
    create: { id: WORKSPACE_ROW_ID, storageBytes: 0 },
    update: {},
  });
}

export async function adjustStorageBytes(
  delta: number,
  client: StorageLedgerClient = prisma,
): Promise<void> {
  if (!Number.isFinite(delta) || delta === 0) return;
  const increment = Math.trunc(delta);
  // Upsert rather than update-after-create: one round trip, and it works on the first call of
  // a fresh installation where the row does not exist yet.
  await client.workspace.upsert({
    where: { id: WORKSPACE_ROW_ID },
    create: { id: WORKSPACE_ROW_ID, storageBytes: Math.max(0, increment) },
    update: { storageBytes: { increment } },
  });
  await client.workspace.updateMany({
    where: { id: WORKSPACE_ROW_ID, storageBytes: { lt: 0 } },
    data: { storageBytes: 0 },
  });
}

export { formatStorageBytes } from './format';
