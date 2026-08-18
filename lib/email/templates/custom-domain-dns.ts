import { escapeHtml, workspaceName, wrapEmailHtml } from './layout';

export function customDomainDnsEmail(input: {
  hostname: string;
  path: 'A' | 'B';
  table: string;
  note: string;
}) {
  const workspace = workspaceName();
  const subject =
    input.path === 'B'
      ? `${workspace} — nameservers for ${input.hostname}`
      : `${workspace} — DNS records for ${input.hostname}`;
  const intro =
    input.path === 'B'
      ? `Set these nameservers on ${input.hostname} at your registrar.`
      : `Add these DNS records for ${input.hostname} at your DNS provider.`;
  const text = [
    `Hello,`,
    ``,
    intro,
    ``,
    input.table,
    ``,
    input.note,
    ``,
    `If you did not expect this email, you can ignore it.`,
  ].join('\n');

  const html = wrapEmailHtml(
    subject,
    `<p style="margin:0 0 12px 0;">Hello,</p>
<p style="margin:0 0 16px 0;">${escapeHtml(intro)}</p>
<pre style="margin:0 0 16px 0;padding:12px;background:#f4f4f5;border-radius:8px;font-size:13px;white-space:pre-wrap;">${escapeHtml(input.table)}</pre>
<p style="margin:0 0 16px 0;">${escapeHtml(input.note)}</p>
<p style="margin:0;">If you did not expect this email, you can ignore it.</p>`,
  );

  return { subject, html, text };
}
