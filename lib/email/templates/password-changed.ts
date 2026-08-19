import { escapeHtml, workspaceName, wrapEmailHtml } from './layout';

export function passwordChangedEmail() {
  const workspace = workspaceName();
  const subject = `${workspace} — password updated`;
  const text = [
    `Hello,`,
    ``,
    `Your ${workspace} password has been updated.`,
    `If you did not do this, request a new reset link right away.`,
  ].join('\n');

  const html = wrapEmailHtml(
    subject,
    `<p style="margin:0 0 12px 0;">Hello,</p>
<p style="margin:0 0 12px 0;">Your ${escapeHtml(workspace)} password has been updated.</p>
<p style="margin:0;">If you did not do this, request a new reset link right away.</p>`,
  );

  // `security` for the same reason as the reset link: this is the mail that tells someone a
  // password they did not change has been changed. Dropping it into the 20-per-hour
  // per-recipient workspace bucket means the one warning of a takeover is the one that never
  // arrives.
  return { subject, html, text, emailClass: 'security' as const };
}
