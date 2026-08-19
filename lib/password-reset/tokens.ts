import { createHash, randomBytes } from 'node:crypto';
import { appPublicUrl } from '@/lib/settings/app-url';

export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

export function hashResetToken(raw: string) {
  return createHash('sha256').update(raw).digest('hex');
}

export function createResetToken() {
  return randomBytes(32).toString('base64url');
}

/**
 * Async because the origin comes from the `app.url` setting first. This read
 * `process.env.APP_URL` directly, so an operator who corrected Application URL
 * on /admin/config kept emailing reset links pointing at the old host, and the
 * report that came back was "password reset is broken".
 */
export async function resetPasswordUrl(rawToken: string) {
  return `${await appPublicUrl()}/reset-password?token=${rawToken}`;
}
