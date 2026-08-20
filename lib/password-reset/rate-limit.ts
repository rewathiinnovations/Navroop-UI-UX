import { createRateLimitStore } from '@/lib/rate-limit/store';

const HOUR_MS = 60 * 60 * 1000;
export const EMAIL_LIMIT = 3;
export const IP_LIMIT = 10;

/**
 * Bounded and swept (F-709): this is reachable unauthenticated with any
 * syntactically valid email, so the store must not grow with attacker-chosen
 * keys or hold them for the process lifetime.
 */
const store = createRateLimitStore();

/**
 * `ip` is null when no trustworthy client address exists (see
 * `lib/auth/client-ip.ts`); the per-email bucket alone throttles then.
 */
export function allowPasswordResetRequest(email: string, ip: string | null, now = new Date()) {
  const ts = now.getTime();
  const emailHit = store.hit(`email:${email}`, EMAIL_LIMIT, HOUR_MS, ts);
  const ipHit = ip ? store.hit(`ip:${ip}`, IP_LIMIT, HOUR_MS, ts) : null;
  return emailHit.allowed && (ipHit?.allowed ?? true);
}

export function clearPasswordResetRateLimits() {
  store.clear();
}
