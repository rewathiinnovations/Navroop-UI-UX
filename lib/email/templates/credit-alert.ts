import { escapeHtml, workspaceName, wrapEmailHtml } from './layout';

/**
 * The 80% credit warning (F-306).
 *
 * `notifyAdminsCredit80` claimed `creditAlert80Sent`, fetched the admin recipients, wrote
 * the receipt row and then only `console.info`d — it never called `mailAdmins`, so this
 * email had never been sent. Credits are counted rather than billed, so the copy talks in
 * credits where its spend siblings talk in dollars. Deliberately no reset date: deriving
 * one here would mean importing the period arithmetic from `lib/plans/limits`, which
 * imports this module's caller.
 */
export function creditAlert80Email(input: { used: number; limit: number }) {
  const workspace = workspaceName();
  const subject = `${workspace} — 80% of this month's credits are used`;
  const text = [
    `Hello,`,
    ``,
    `This workspace has used ${input.used} of its ${input.limit} monthly credits.`,
    `The allowance resets at the start of the next period.`,
    `Open Admin → Workspace to raise the plan or set a per-member cap.`,
  ].join('\n');
  const html = wrapEmailHtml(
    subject,
    `<p style="margin:0 0 12px 0;">Hello,</p>
<p style="margin:0 0 16px 0;">This workspace has used ${escapeHtml(String(input.used))} of its ${escapeHtml(String(input.limit))} monthly credits. The allowance resets at the start of the next period.</p>
<p style="margin:0;">Open Admin → Workspace to raise the plan or set a per-member cap.</p>`,
  );
  return { subject, html, text };
}
