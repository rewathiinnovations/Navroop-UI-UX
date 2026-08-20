import { INVITE_TTL_LABEL } from '@/lib/invites/tokens';
import { escapeHtml, workspaceName, wrapEmailHtml } from './layout';

/**
 * The mail that replaced the out-of-band temporary password (F-351). Before this, an admin
 * was handed a password on screen and had to relay it over whatever channel they picked —
 * chat, SMS, a sticky note — and the invitee was never made to change it.
 */
export function inviteEmail(input: { acceptUrl: string; invitedByName?: string | null }) {
  const workspace = workspaceName();
  const subject = `${workspace} — you have been invited`;
  const from = input.invitedByName?.trim();
  const opening = from
    ? `${from} invited you to ${workspace}.`
    : `You have been invited to ${workspace}.`;

  const text = [
    `Hello,`,
    ``,
    `${opening} Open this link to choose a password and finish setting up your account. The link works once and expires in ${INVITE_TTL_LABEL}:`,
    input.acceptUrl,
    ``,
    `If you were not expecting this, ignore this email — the invite cannot be used by anyone who does not open the link.`,
  ].join('\n');

  const html = wrapEmailHtml(
    subject,
    `<p style="margin:0 0 12px 0;">Hello,</p>
<p style="margin:0 0 16px 0;">${escapeHtml(opening)} Click the button below to choose a password and finish setting up your account. The link works once and expires in ${escapeHtml(INVITE_TTL_LABEL)}.</p>
<table role="presentation" cellspacing="0" cellpadding="0">
  <tr>
    <td style="background:#18181b;border-radius:999px;">
      <a href="${escapeHtml(input.acceptUrl)}" style="display:inline-block;padding:12px 20px;color:#ffffff;text-decoration:none;font-size:14px;font-weight:bold;">Accept invite</a>
    </td>
  </tr>
</table>
<p style="margin:16px 0 0 0;font-size:13px;color:#71717a;word-break:break-all;">${escapeHtml(input.acceptUrl)}</p>
<p style="margin:16px 0 0 0;">If you were not expecting this, ignore this email.</p>`,
  );

  /**
   * `security`, for the reason `passwordResetEmail` gives: this is the only way into the
   * account, and the 20-per-hour per-recipient workspace bucket would drop it silently
   * while the admin's screen said the invite was sent.
   */
  return { subject, html, text, emailClass: 'security' as const };
}
