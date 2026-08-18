import { escapeHtml, workspaceName, wrapEmailHtml } from './layout';

export function recurringCredit80Email(input: { name: string; remainingUsd: number; totalUsd: number }) {
  const workspace = workspaceName();
  const subject = `${workspace} — ${input.name} monthly sandbox credit is at 80%`;
  const text = [
    `Hello,`,
    ``,
    `${input.name} has used 80% of its monthly sandbox credit.`,
    `Remaining: $${input.remainingUsd.toFixed(2)} of $${input.totalUsd.toFixed(2)}.`,
    `This is informational only. Unused monthly credit is lost when the period resets.`,
  ].join('\n');
  const html = wrapEmailHtml(
    subject,
    `<p style="margin:0 0 12px 0;">Hello,</p>
<p style="margin:0 0 16px 0;">${escapeHtml(input.name)} has used 80% of its monthly sandbox credit.</p>
<p style="margin:0;">Remaining: $${escapeHtml(input.remainingUsd.toFixed(2))} of $${escapeHtml(input.totalUsd.toFixed(2))}. This is informational only.</p>`,
  );
  return { subject, html, text };
}

export function oneTimeLowEmail(input: { name: string; remainingUsd: number; monthsRemaining: number }) {
  const workspace = workspaceName();
  const months =
    Number.isFinite(input.monthsRemaining) ? input.monthsRemaining.toFixed(1) : 'unknown';
  const subject = `${workspace} — ${input.name} one-time sandbox credit is below 10%`;
  const text = [
    `Hello,`,
    ``,
    `${input.name} one-time sandbox credit is below 10%.`,
    `Remaining: $${input.remainingUsd.toFixed(2)}.`,
    `Projected months left at the last 30-day burn: ${months}.`,
    `One-time credit never refills. Add a provider or raise the pool before it reaches zero.`,
  ].join('\n');
  const html = wrapEmailHtml(
    subject,
    `<p style="margin:0 0 12px 0;">Hello,</p>
<p style="margin:0 0 16px 0;">${escapeHtml(input.name)} one-time sandbox credit is below 10%.</p>
<p style="margin:0 0 16px 0;">Remaining: $${escapeHtml(input.remainingUsd.toFixed(2))}. Projected months left at the last 30-day burn: ${escapeHtml(months)}.</p>
<p style="margin:0;">One-time credit never refills. Add a provider or raise the pool before it reaches zero.</p>`,
  );
  return { subject, html, text };
}

export function oneTimeExhaustedEmail(input: { name: string }) {
  const workspace = workspaceName();
  const subject = `${workspace} — ${input.name} one-time sandbox credit is exhausted`;
  const text = [
    `Hello,`,
    ``,
    `${input.name} one-time sandbox credit reached zero.`,
    `The provider was deactivated and health probes have stopped.`,
    `Generation will use the next eligible provider, or fail if none remain.`,
  ].join('\n');
  const html = wrapEmailHtml(
    subject,
    `<p style="margin:0 0 12px 0;">Hello,</p>
<p style="margin:0 0 16px 0;">${escapeHtml(input.name)} one-time sandbox credit reached zero.</p>
<p style="margin:0;">The provider was deactivated and health probes have stopped.</p>`,
  );
  return { subject, html, text };
}
