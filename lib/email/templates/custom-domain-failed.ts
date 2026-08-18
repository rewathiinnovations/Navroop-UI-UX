import { escapeHtml, workspaceName, wrapEmailHtml } from './layout';

export function customDomainFailedEmail(input: { hostname: string; lastError: string }) {
  const workspace = workspaceName();
  const subject = `${workspace} — custom domain failed: ${input.hostname}`;
  const text = [
    `Hello,`,
    ``,
    `The custom domain ${input.hostname} did not verify within 7 days.`,
    ``,
    input.lastError,
    ``,
    `Check the DNS records (found vs expected) and try again.`,
  ].join('\n');

  const html = wrapEmailHtml(
    subject,
    `<p style="margin:0 0 12px 0;">Hello,</p>
<p style="margin:0 0 16px 0;">The custom domain <strong>${escapeHtml(input.hostname)}</strong> did not verify within 7 days.</p>
<p style="margin:0 0 16px 0;">${escapeHtml(input.lastError)}</p>
<p style="margin:0;">Check the DNS records (found vs expected) and try again.</p>`,
  );

  return { subject, html, text };
}
