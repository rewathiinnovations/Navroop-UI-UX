import { createHash, randomBytes } from 'node:crypto';
import { appPublicUrl } from '@/lib/settings/app-url';

/**
 * The invite token, built the way `lib/password-reset/tokens.ts` builds the reset token —
 * 32 random bytes handed out once, sha256 stored (F-351). The two flows are deliberately
 * identical in mechanism: the invite is the reset link's twin for an account whose password
 * has never been set.
 */

/**
 * A week. Longer than the 60-minute reset window because an invite is not a response to
 * something the recipient just did — they have to notice the mail first — and short enough
 * that a forwarded mailbox does not stay claimable for months.
 */
export const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Human form of the TTL, for the email and the admin dialog. Keep the two in step. */
export const INVITE_TTL_LABEL = '7 days';

export function hashInviteToken(raw: string) {
  return createHash('sha256').update(raw).digest('hex');
}

export function createInviteToken() {
  return randomBytes(32).toString('base64url');
}

/** Async because the origin is the `app.url` setting first, environment second. */
export async function acceptInviteUrl(rawToken: string) {
  return `${await appPublicUrl()}/accept-invite?token=${rawToken}`;
}
