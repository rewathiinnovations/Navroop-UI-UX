import { escapeHtml, workspaceName, wrapEmailHtml } from './layout';

export function spendAlert80Email(input: { used: number; limit: number }) {
  const workspace = workspaceName();
  const subject = `${workspace} — workspace spend is at 80%`;
  const text = [
    `Hello,`,
    ``,
    `This workspace has used $${input.used.toFixed(2)} of its $${input.limit.toFixed(2)} monthly spend limit.`,
    `Open Admin → Workspace to review the ceiling.`,
  ].join('\n');
  const html = wrapEmailHtml(
    subject,
    `<p style="margin:0 0 12px 0;">Hello,</p>
<p style="margin:0 0 16px 0;">This workspace has used $${escapeHtml(input.used.toFixed(2))} of its $${escapeHtml(input.limit.toFixed(2))} monthly spend limit.</p>
<p style="margin:0;">Open Admin → Workspace to review the ceiling.</p>`,
  );
  return { subject, html, text };
}

export function spendLimitEmail(input: { used: number; limit: number }) {
  const workspace = workspaceName();
  const subject = `${workspace} — generation paused at the spend limit`;
  const text = [
    `Hello,`,
    ``,
    `This workspace reached its $${input.limit.toFixed(2)} monthly spend limit (now $${input.used.toFixed(2)}).`,
    `Generation is paused automatically. Open Admin → Workspace to resume or raise the limit.`,
  ].join('\n');
  const html = wrapEmailHtml(
    subject,
    `<p style="margin:0 0 12px 0;">Hello,</p>
<p style="margin:0 0 16px 0;">This workspace reached its $${escapeHtml(input.limit.toFixed(2))} monthly spend limit (now $${escapeHtml(input.used.toFixed(2))}).</p>
<p style="margin:0;">Generation is paused automatically. Open Admin → Workspace to resume or raise the limit.</p>`,
  );
  return { subject, html, text };
}
