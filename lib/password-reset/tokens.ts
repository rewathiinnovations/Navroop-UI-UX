import { createHash, randomBytes } from 'node:crypto';

export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

export function hashResetToken(raw: string) {
  return createHash('sha256').update(raw).digest('hex');
}

export function createResetToken() {
  return randomBytes(32).toString('base64url');
}

export function appOrigin() {
  return (
    process.env.APP_URL ||
    process.env.NEXTAUTH_URL ||
    process.env.AUTH_URL ||
    'http://localhost:3000'
  ).replace(/\/$/, '');
}

export function resetPasswordUrl(rawToken: string) {
  return `${appOrigin()}/reset-password?token=${rawToken}`;
}
