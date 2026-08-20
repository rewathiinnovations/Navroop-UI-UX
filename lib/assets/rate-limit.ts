/**
 * Per-user hourly caps on the two image uploads a session user can drive — the
 * same in-process bucket the ZIP export uses (`lib/export/rate-limit.ts`).
 * Uploads are manual, one-at-a-time panel actions, so a real user never
 * approaches either ceiling; a script hammering `POST /api/projects/{id}/assets`
 * or the avatar action does.
 */
const HOUR_MS = 60 * 60 * 1000;
export const UPLOAD_LIMIT = 30;

/**
 * Avatars get their own bucket and a tighter ceiling than project assets (F-173).
 *
 * Separate, because one shared counter lets avatar spam eat the project-asset
 * budget a user is legitimately in the middle of spending — a limiter that
 * refuses the wrong action is worse than the one that was missing. Tighter,
 * because the shapes of the two actions differ: a project accumulates many
 * assets, while an avatar is a single slot that each upload overwrites, so ten
 * attempts an hour already covers someone trying different crops.
 *
 * Keyed on the session user id, like every other bucket here. There is no other
 * identity to key on — the action runs behind `requireSessionUser`, so an
 * unauthenticated caller never reaches it and an IP key would only merge
 * everyone behind one NAT into a single shared ceiling.
 */
export const AVATAR_UPLOAD_LIMIT = 10;

type Bucket = { count: number; resetAt: number };

const assetBuckets = new Map<string, Bucket>();
const avatarBuckets = new Map<string, Bucket>();

function take(buckets: Map<string, Bucket>, key: string, limit: number, now: Date) {
  const ts = now.getTime();
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= ts) {
    buckets.set(key, { count: 1, resetAt: ts + HOUR_MS });
    return { allowed: true, count: 1 };
  }
  existing.count += 1;
  return { allowed: existing.count <= limit, count: existing.count };
}

export function allowAssetUpload(userId: string, now = new Date()) {
  return take(assetBuckets, userId, UPLOAD_LIMIT, now);
}

export function clearAssetUploadRateLimits() {
  assetBuckets.clear();
}

export function allowAvatarUpload(userId: string, now = new Date()) {
  return take(avatarBuckets, userId, AVATAR_UPLOAD_LIMIT, now);
}

export function clearAvatarUploadRateLimits() {
  avatarBuckets.clear();
}
