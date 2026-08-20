/**
 * Per-user hourly cap on asset uploads — the same in-process bucket the ZIP
 * export uses (`lib/export/rate-limit.ts`). Uploads are manual, one-at-a-time
 * panel actions, so a real user never approaches this; a script hammering
 * `POST /api/projects/{id}/assets` does.
 */
const HOUR_MS = 60 * 60 * 1000;
export const UPLOAD_LIMIT = 30;

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

export function allowAssetUpload(userId: string, now = new Date()) {
  const ts = now.getTime();
  const existing = buckets.get(userId);
  if (!existing || existing.resetAt <= ts) {
    buckets.set(userId, { count: 1, resetAt: ts + HOUR_MS });
    return { allowed: true, count: 1 };
  }
  existing.count += 1;
  return { allowed: existing.count <= UPLOAD_LIMIT, count: existing.count };
}

export function clearAssetUploadRateLimits() {
  buckets.clear();
}
