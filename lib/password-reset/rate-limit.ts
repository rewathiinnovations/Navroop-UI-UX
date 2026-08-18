const HOUR_MS = 60 * 60 * 1000;
export const EMAIL_LIMIT = 3;
export const IP_LIMIT = 10;

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

function hit(key: string, limit: number, now: number, windowMs = HOUR_MS) {
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, count: 1 };
  }
  existing.count += 1;
  return { allowed: existing.count <= limit, count: existing.count };
}

export function allowPasswordResetRequest(email: string, ip: string, now = new Date()) {
  const ts = now.getTime();
  const emailHit = hit(`email:${email}`, EMAIL_LIMIT, ts);
  const ipHit = hit(`ip:${ip || 'unknown'}`, IP_LIMIT, ts);
  return emailHit.allowed && ipHit.allowed;
}

export function clearPasswordResetRateLimits() {
  buckets.clear();
}
