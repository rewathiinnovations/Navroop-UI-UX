import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const GITHUB_OAUTH_STATE_COOKIE = 'github_oauth_state';
export const GITHUB_OAUTH_STATE_MAX_AGE_SEC = 5 * 60;

function signingSecret() {
  return process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || '';
}

function signState(state: string, secret: string) {
  return createHmac('sha256', secret).update(state).digest('hex');
}

export function oauthStateCookieOptions() {
  return {
    httpOnly: true as const,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    maxAge: GITHUB_OAUTH_STATE_MAX_AGE_SEC,
    path: '/',
  };
}

export function createOAuthState(secret = signingSecret()) {
  if (!secret) {
    throw new Error('AUTH_SECRET is required to sign the GitHub OAuth state cookie');
  }
  const state = randomBytes(32).toString('hex');
  return { state, cookieValue: `${state}.${signState(state, secret)}` };
}

export function verifyOAuthState(
  cookieValue: string | undefined | null,
  state: string | undefined | null,
  secret = signingSecret(),
) {
  if (!cookieValue || !state || !secret) return false;
  const dot = cookieValue.indexOf('.');
  if (dot <= 0) return false;
  const cookieState = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);
  if (!sig || cookieState !== state) return false;
  const expected = signState(state, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
