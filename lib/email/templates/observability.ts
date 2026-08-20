import { escapeHtml, workspaceName, wrapEmailHtml } from './layout';

export function heartbeatFailedEmail() {
  const workspace = workspaceName();
  const subject = `${workspace} — error tracking heartbeat failed twice`;
  const text = [
    `Hello,`,
    ``,
    `The error-tracking heartbeat failed to flush to Sentry twice in a row.`,
    `Sentry going silent is not the same as having no errors. Open Admin → Health.`,
  ].join('\n');
  const html = wrapEmailHtml(
    subject,
    `<p style="margin:0 0 12px 0;">Hello,</p>
<p style="margin:0 0 16px 0;">The error-tracking heartbeat failed to flush to Sentry twice in a row.</p>
<p style="margin:0;">Sentry going silent is not the same as having no errors. Open Admin → Health.</p>`,
  );
  return { subject, html, text, emailClass: 'security' as const };
}

export function heartbeatMismatchEmail() {
  const workspace = workspaceName();
  const subject = `${workspace} — heartbeat sent but not visible in Sentry`;
  const text = [
    `Hello,`,
    ``,
    `A heartbeat was sent locally more than 3 hours ago, but Sentry has not confirmed receipt.`,
    `Likely causes: quota, rate limit, inbound filter, or the DSN changed.`,
    `Open Admin → Health to compare the two timestamps.`,
  ].join('\n');
  const html = wrapEmailHtml(
    subject,
    `<p style="margin:0 0 12px 0;">Hello,</p>
<p style="margin:0 0 16px 0;">A heartbeat was sent locally more than 3 hours ago, but Sentry has not confirmed receipt.</p>
<p style="margin:0 0 16px 0;">Likely causes: quota, rate limit, inbound filter, or the DSN changed.</p>
<p style="margin:0;">Open Admin → Health to compare the two timestamps.</p>`,
  );
  return { subject, html, text, emailClass: 'security' as const };
}

function droppedLines(dropped: Array<{ reason: string; count: number }>) {
  return dropped.map((row) => `- ${row.reason}: ${row.count} event(s) dropped`);
}

function droppedHtml(dropped: Array<{ reason: string; count: number }>) {
  return dropped
    .map(
      (row) =>
        `<li>${escapeHtml(row.reason)}: ${escapeHtml(String(row.count))} event(s) dropped</li>`,
    )
    .join('');
}

export function quotaWarningEmail(input: {
  used: number;
  limit: number;
  topIssues: Array<{ title: string; count: number }>;
  dropped?: Array<{ reason: string; count: number }>;
}) {
  const workspace = workspaceName();
  const subject = `${workspace} — Sentry quota is above 80%`;
  const issueLines = input.topIssues
    .slice(0, 3)
    .map((issue) => `- ${issue.title} (${issue.count})`);
  const dropped = input.dropped ?? [];
  const text = [
    `Hello,`,
    ``,
    `Error tracking has used ${input.used} of ${input.limit} events this period.`,
    ...(dropped.length
      ? [`Sentry is already discarding events:`, ...droppedLines(dropped), ``]
      : []),
    `Top issues:`,
    ...issueLines,
    ``,
    `Open Admin → Health.`,
  ].join('\n');
  const issuesHtml = input.topIssues
    .slice(0, 3)
    .map((issue) => `<li>${escapeHtml(issue.title)} (${escapeHtml(String(issue.count))})</li>`)
    .join('');
  const html = wrapEmailHtml(
    subject,
    `<p style="margin:0 0 12px 0;">Hello,</p>
<p style="margin:0 0 16px 0;">Error tracking has used ${escapeHtml(String(input.used))} of ${escapeHtml(String(input.limit))} events this period.</p>
${dropped.length ? `<p style="margin:0 0 8px 0;">Sentry is already discarding events:</p><ul style="margin:0 0 16px 0;padding-left:20px;">${droppedHtml(dropped)}</ul>` : ''}
<ul style="margin:0 0 16px 0;padding-left:20px;">${issuesHtml}</ul>
<p style="margin:0;">Open Admin → Health.</p>`,
  );
  return { subject, html, text, emailClass: 'security' as const };
}

/**
 * Sentry is dropping events while the quota ratio is still low — an inbound filter or a
 * per-key rate limit. The daily check used to compute this, store it in the check detail,
 * and tell nobody (F-632).
 */
export function eventsDroppedEmail(input: {
  dropped: Array<{ reason: string; count: number }>;
  topIssues: Array<{ title: string; count: number }>;
}) {
  const workspace = workspaceName();
  const subject = `${workspace} — Sentry is dropping error events`;
  const issueLines = input.topIssues
    .slice(0, 3)
    .map((issue) => `- ${issue.title} (${issue.count})`);
  const text = [
    `Hello,`,
    ``,
    `Sentry discarded events for this project in the last 24 hours:`,
    ...droppedLines(input.dropped),
    ``,
    `Errors are being thrown away, so the error tracker is no longer a complete record.`,
    `Likely causes: a per-key rate limit, an inbound filter, or a spend cap.`,
    ...(issueLines.length ? [``, `Top issues:`, ...issueLines] : []),
    ``,
    `Open Admin → Health.`,
  ].join('\n');
  const issuesHtml = input.topIssues
    .slice(0, 3)
    .map((issue) => `<li>${escapeHtml(issue.title)} (${escapeHtml(String(issue.count))})</li>`)
    .join('');
  const html = wrapEmailHtml(
    subject,
    `<p style="margin:0 0 12px 0;">Hello,</p>
<p style="margin:0 0 8px 0;">Sentry discarded events for this project in the last 24 hours:</p>
<ul style="margin:0 0 16px 0;padding-left:20px;">${droppedHtml(input.dropped)}</ul>
<p style="margin:0 0 16px 0;">Errors are being thrown away, so the error tracker is no longer a complete record. Likely causes: a per-key rate limit, an inbound filter, or a spend cap.</p>
${issuesHtml ? `<ul style="margin:0 0 16px 0;padding-left:20px;">${issuesHtml}</ul>` : ''}
<p style="margin:0;">Open Admin → Health.</p>`,
  );
  return { subject, html, text, emailClass: 'security' as const };
}

export function dsnMissingEmail() {
  const workspace = workspaceName();
  const subject = `${workspace} — Sentry DSN is missing in production`;
  const text = [
    `Hello,`,
    ``,
    `This production instance started without a Sentry DSN. Errors will not be reported.`,
    `Connect Sentry in Admin → Integrations and restart. Open Admin → Health.`,
  ].join('\n');
  const html = wrapEmailHtml(
    subject,
    `<p style="margin:0 0 12px 0;">Hello,</p>
<p style="margin:0 0 16px 0;">This production instance started without a Sentry DSN. Errors will not be reported.</p>
<p style="margin:0;">Connect Sentry in Admin → Integrations and restart. Open Admin → Health.</p>`,
  );
  return { subject, html, text, emailClass: 'security' as const };
}

export function systemChecksDigestEmail(input: { lines: string[] }) {
  const workspace = workspaceName();
  const subject = `${workspace} — system checks need attention`;
  const text = [
    `Hello,`,
    ``,
    `These background jobs are stale or failing:`,
    ...input.lines.map((line) => `- ${line}`),
    ``,
    `Open Admin → Health.`,
  ].join('\n');
  const items = input.lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('');
  const html = wrapEmailHtml(
    subject,
    `<p style="margin:0 0 12px 0;">Hello,</p>
<p style="margin:0 0 16px 0;">These background jobs are stale or failing:</p>
<ul style="margin:0 0 16px 0;padding-left:20px;">${items}</ul>
<p style="margin:0;">Open Admin → Health.</p>`,
  );
  return { subject, html, text, emailClass: 'security' as const };
}
