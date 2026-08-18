import { escapeHtml, workspaceName, wrapEmailHtml } from './layout';

export function backupFailedEmail(input: { message: string }) {
  const workspace = workspaceName();
  const subject = `${workspace} — backup needs attention`;
  const text = [
    `Hello,`,
    ``,
    input.message,
    ``,
    `Open Admin → Backups to inspect recent runs.`,
  ].join('\n');

  const html = wrapEmailHtml(
    subject,
    `<p style="margin:0 0 12px 0;">Hello,</p>
<p style="margin:0 0 16px 0;">${escapeHtml(input.message)}</p>
<p style="margin:0;">Open Admin → Backups to inspect recent runs.</p>`,
  );

  return { subject, html, text };
}
