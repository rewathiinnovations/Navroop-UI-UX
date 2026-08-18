import { escapeHtml, workspaceName, wrapEmailHtml } from './layout';

export function volumeLowSpaceEmail(input: { path: string; freeRatio: number; freeBytes: number }) {
  const workspace = workspaceName();
  const percent = Math.max(0, Math.round(input.freeRatio * 100));
  const subject = `${workspace} — persistent volume is under 10% free`;
  const text = [
    `Hello,`,
    ``,
    `The persistent volume at ${input.path} has ${percent}% free space remaining (${input.freeBytes} bytes).`,
    `Temporary files and caches live here. Clear old tmp files or grow the volume.`,
    `Open Admin → Health.`,
  ].join('\n');
  const html = wrapEmailHtml(
    subject,
    `<p style="margin:0 0 12px 0;">Hello,</p>
<p style="margin:0 0 16px 0;">The persistent volume at <strong>${escapeHtml(input.path)}</strong> has ${percent}% free space remaining.</p>
<p style="margin:0;">Temporary files and caches live here. Clear old tmp files or grow the volume. Open Admin → Health.</p>`,
  );
  return { subject, html, text, emailClass: 'security' as const };
}
