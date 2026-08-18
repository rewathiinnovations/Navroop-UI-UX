import { getSetting } from '@/lib/settings/resolve';

const DEFAULT_CHECKPOINT_RETENTION_DAYS = 7;
const DEFAULT_PURGE_DELETED_DAYS = 30;

function positiveDays(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function checkpointRetentionDays() {
  return positiveDays(
    await getSetting('app.checkpointRetentionDays'),
    DEFAULT_CHECKPOINT_RETENTION_DAYS,
  );
}

export async function purgeDeletedDays() {
  return positiveDays(await getSetting('app.purgeDeletedDays'), DEFAULT_PURGE_DELETED_DAYS);
}

export function isThinEligible(input: {
  id: string;
  latestId: string;
  createdAt: Date;
  isBookmarked: boolean;
  snapshotPruned: boolean;
  now?: Date;
  retentionDays?: number;
}) {
  if (input.id === input.latestId) return false;
  if (input.isBookmarked) return false;
  if (input.snapshotPruned) return false;
  const now = input.now ?? new Date();
  const days = input.retentionDays ?? DEFAULT_CHECKPOINT_RETENTION_DAYS;
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return input.createdAt < cutoff;
}
