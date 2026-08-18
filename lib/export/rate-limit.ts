const HOUR_MS = 60 * 60 * 1000;
export const EXPORT_LIMIT = 5;

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

export function allowExport(userId: string, now = new Date()) {
  const ts = now.getTime();
  const existing = buckets.get(userId);
  if (!existing || existing.resetAt <= ts) {
    buckets.set(userId, { count: 1, resetAt: ts + HOUR_MS });
    return { allowed: true, count: 1 };
  }
  existing.count += 1;
  return { allowed: existing.count <= EXPORT_LIMIT, count: existing.count };
}

export function clearExportRateLimits() {
  buckets.clear();
}
