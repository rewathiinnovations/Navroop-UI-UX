import { escapeHtml, workspaceName, wrapEmailHtml } from './layout';

export function dataRequestEmail(input: {
  requesterName: string;
  requesterEmail: string;
  kind: 'export' | 'deletion';
  note?: string;
}) {
  const workspace = workspaceName();
  const label = input.kind === 'deletion' ? 'account deletion' : 'data export';
  const subject = `${workspace} — ${label} request from ${input.requesterEmail}`;
  const note = input.note?.trim() ? `\n\nNote:\n${input.note.trim()}` : '';
  const text = [
    `A ${label} request was submitted in ${workspace}.`,
    ``,
    `Name: ${input.requesterName}`,
    `Email: ${input.requesterEmail}`,
    `Kind: ${input.kind}`,
    note.trim(),
    ``,
    `Do not delete the account automatically. An admin should review and act.`,
  ]
    .filter((line) => line !== '')
    .join('\n');

  const html = wrapEmailHtml(
    subject,
    `<p style="margin:0 0 12px 0;">A ${escapeHtml(label)} request was submitted in ${escapeHtml(workspace)}.</p>
<p style="margin:0 0 8px 0;"><strong>Name:</strong> ${escapeHtml(input.requesterName)}</p>
<p style="margin:0 0 8px 0;"><strong>Email:</strong> ${escapeHtml(input.requesterEmail)}</p>
<p style="margin:0 0 8px 0;"><strong>Kind:</strong> ${escapeHtml(input.kind)}</p>
${input.note?.trim() ? `<p style="margin:12px 0 0 0;"><strong>Note:</strong> ${escapeHtml(input.note.trim())}</p>` : ''}
<p style="margin:16px 0 0 0;">Do not delete the account automatically. An admin should review and act.</p>`,
  );

  return { subject, html, text };
}
