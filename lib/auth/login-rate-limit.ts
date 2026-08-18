const WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_ATTEMPT_LIMIT = 5;

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

function keyFor(email: string, ip: string) {
  return `${email.trim().toLowerCase()}|${ip || 'unknown'}`;
}

export function allowLoginAttempt(email: string, ip: string, now = new Date()) {
  const key = keyFor(email, ip);
  const ts = now.getTime();
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= ts) {
    buckets.set(key, { count: 1, resetAt: ts + WINDOW_MS });
    return { allowed: true, count: 1, remaining: LOGIN_ATTEMPT_LIMIT - 1 };
  }
  existing.count += 1;
  const allowed = existing.count <= LOGIN_ATTEMPT_LIMIT;
  return {
    allowed,
    count: existing.count,
    remaining: Math.max(0, LOGIN_ATTEMPT_LIMIT - existing.count),
  };
}

export function recordLoginSuccess(email: string, ip: string) {
  buckets.delete(keyFor(email, ip));
}

export function clearLoginRateLimits() {
  buckets.clear();
}

export const LOGIN_RATE_LIMIT_MESSAGE = 'Too many sign-in attempts. Try again in 15 minutes.';
