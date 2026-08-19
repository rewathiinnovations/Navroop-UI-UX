import { escapeHtml, workspaceName, wrapEmailHtml } from './layout';

export function passwordResetEmail(resetUrl: string) {
  const workspace = workspaceName();
  const subject = `${workspace} — reset your password`;
  const text = [
    `Hello,`,
    ``,
    `Open this link to reset your password on ${workspace}. The link expires in 60 minutes:`,
    resetUrl,
    ``,
    `If you did not request this, ignore this email.`,
  ].join('\n');

  const html = wrapEmailHtml(
    subject,
    `<p style="margin:0 0 12px 0;">Hello,</p>
<p style="margin:0 0 16px 0;">Click the button below to reset your password on ${escapeHtml(workspace)}. The link expires in 60 minutes.</p>
<table role="presentation" cellspacing="0" cellpadding="0">
  <tr>
    <td style="background:#18181b;border-radius:999px;">
      <a href="${escapeHtml(resetUrl)}" style="display:inline-block;padding:12px 20px;color:#ffffff;text-decoration:none;font-size:14px;font-weight:bold;">Reset password</a>
    </td>
  </tr>
</table>
<p style="margin:16px 0 0 0;font-size:13px;color:#71717a;word-break:break-all;">${escapeHtml(resetUrl)}</p>
<p style="margin:16px 0 0 0;">If you did not request this, ignore this email.</p>`,
  );

  /**
   * `security`, like the observability alerts, so `allowEmail` does not drop it into the
   * 20-per-hour per-recipient workspace bucket. An admin who also receives spend alerts, DNS
   * notices and backup failures at this address can cross that ceiling, and then the only
   * trace of the missing reset link is a server-side `console.error` — the UI still says a
   * link has been sent. Abuse is already capped upstream by `allowPasswordResetRequest`
   * (3/email/hr, 10/IP/hr), so the workspace bucket adds nothing here but silent loss.
   */
  return { subject, html, text, emailClass: 'security' as const };
}
