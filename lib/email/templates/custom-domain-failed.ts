import { escapeHtml, workspaceName, wrapEmailHtml } from './layout';

/**
 * Sent to the project owner, the publisher and the admins (F-263) — it used to reach only
 * the admins, who cannot change a record at somebody else's registrar. `projectName` and
 * `domainsUrl` are what turn it from a report into something the recipient can act on; both
 * are optional because the deployment row may be gone by the time the verifier gives up.
 *
 * Not `emailClass: 'security'`: a domain that failed DNS verification is an operational
 * notice, and the security exemption exists so a password reset cannot be rate-limited away.
 */
export function customDomainFailedEmail(input: {
  hostname: string;
  lastError: string;
  projectName?: string | null;
  domainsUrl?: string | null;
}) {
  const workspace = workspaceName();
  const subject = `${workspace} — custom domain failed: ${input.hostname}`;
  const project = input.projectName ? ` for ${input.projectName}` : '';
  const text = [
    `Hello,`,
    ``,
    `The custom domain ${input.hostname}${project} did not verify within 7 days.`,
    ``,
    input.lastError,
    ``,
    `Check the DNS records (found vs expected) and try again.`,
    ...(input.domainsUrl ? [``, input.domainsUrl] : []),
  ].join('\n');

  const html = wrapEmailHtml(
    subject,
    `<p style="margin:0 0 12px 0;">Hello,</p>
<p style="margin:0 0 16px 0;">The custom domain <strong>${escapeHtml(input.hostname)}</strong>${escapeHtml(project)} did not verify within 7 days.</p>
<p style="margin:0 0 16px 0;">${escapeHtml(input.lastError)}</p>
<p style="margin:0;">Check the DNS records (found vs expected) and try again.</p>${
      input.domainsUrl
        ? `\n<p style="margin:16px 0 0 0;"><a href="${escapeHtml(input.domainsUrl)}" style="color:#2563eb;">Open the domain settings</a></p>`
        : ''
    }`,
  );

  return { subject, html, text };
}
