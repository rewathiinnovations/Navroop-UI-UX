import { createRateLimitStore } from '@/lib/rate-limit/store';

const WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_ATTEMPT_LIMIT = 5;
/**
 * Higher than the per-email limit on purpose: one office NAT holds many users,
 * and the per-email bucket is the control that actually stops guessing a
 * single account. The IP bucket exists to cap spraying many emails from one
 * source (F-302), which the old `email|ip` pair key never did.
 */
export const LOGIN_IP_ATTEMPT_LIMIT = 20;

const store = createRateLimitStore();

/**
 * Two independent buckets — one per normalised email, one per client IP —
 * and the attempt is refused when either is exhausted. `ip` is null when no
 * trustworthy client address exists (see `lib/auth/client-ip.ts`); the email
 * bucket alone throttles then, rather than a spoofable header minting fresh
 * buckets or all callers sharing one.
 */
export function allowLoginAttempt(email: string, ip: string | null, now = new Date()) {
  const ts = now.getTime();
  const emailHit = store.hit(
    `email:${email.trim().toLowerCase()}`,
    LOGIN_ATTEMPT_LIMIT,
    WINDOW_MS,
    ts,
  );
  const ipHit = ip ? store.hit(`ip:${ip}`, LOGIN_IP_ATTEMPT_LIMIT, WINDOW_MS, ts) : null;
  return {
    allowed: emailHit.allowed && (ipHit?.allowed ?? true),
    count: emailHit.count,
    remaining: Math.max(0, LOGIN_ATTEMPT_LIMIT - emailHit.count),
  };
}

export function recordLoginSuccess(email: string) {
  store.delete(`email:${email.trim().toLowerCase()}`);
}

export function clearLoginRateLimits() {
  store.clear();
}

export const LOGIN_RATE_LIMIT_MESSAGE = 'Too many sign-in attempts. Try again in 15 minutes.';
