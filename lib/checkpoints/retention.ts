export function checkpointRetentionDays() {
  const parsed = Number(process.env.CHECKPOINT_RETENTION_DAYS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 7;
}

export function purgeDeletedDays() {
  const parsed = Number(process.env.PURGE_DELETED_DAYS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
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
  const days = input.retentionDays ?? checkpointRetentionDays();
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return input.createdAt < cutoff;
}
