import { positiveNumberSetting } from '@/lib/settings/numbers';

const DEFAULT_CHECKPOINT_RETENTION_DAYS = 7;
const DEFAULT_PURGE_DELETED_DAYS = 30;

export async function checkpointRetentionDays() {
  return positiveNumberSetting('app.checkpointRetentionDays', DEFAULT_CHECKPOINT_RETENTION_DAYS);
}

export async function purgeDeletedDays() {
  return positiveNumberSetting('app.purgeDeletedDays', DEFAULT_PURGE_DELETED_DAYS);
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
