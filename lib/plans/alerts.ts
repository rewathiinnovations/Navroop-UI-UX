import { prisma } from '@/lib/db';
import { sendEmail } from '@/lib/email/client';
import { creditAlert80Email } from '@/lib/email/templates/credit-alert';
import { spendAlert80Email, spendLimitEmail } from '@/lib/email/templates/spend-alert';
import { trackFailure } from '@/lib/observability/track';

async function adminRecipients() {
  return prisma.user.findMany({
    where: { role: 'ADMIN', isActive: true },
    select: { id: true, email: true },
  });
}

/**
 * Sends to every admin and reports how it went.
 *
 * `sendEmail` never throws — it answers `{ ok: false, error }` for a rate-limited
 * recipient, a rejected provider call or a missing address. The old body was
 * `await sendEmail(…).catch(() => undefined)`, which caught nothing and read nothing, so a
 * failed admin email was indistinguishable from a delivered one. A caller that needs to
 * know whether the alert left the process — `notifyAdminsCredit80` hands its
 * `creditAlert80Sent` claim back on a `false` — had no way to find out.
 */
async function mailAdmins(
  admins: Array<{ email: string }>,
  template: { subject: string; html: string; text: string },
) {
  let sent = 0;
  let failed = 0;
  for (const admin of admins) {
    if (!admin.email) continue;
    const result = await sendEmail({ to: admin.email, ...template });
    if ('ok' in result) {
      failed += 1;
      trackFailure('plans.admin_email_failed', new Error(result.error), {
        action: 'plans.alert_email',
        subject: template.subject,
      });
      continue;
    }
    sent += 1;
  }
  return { sent, failed };
}

/**
 * Non-throwing, like its siblings below. This one used to let the `AppSetting` upsert
 * escape: `consumeCredits` calls it after its transaction has committed, and
 * `chargeJobCreditsOnce` reads any throw from there as a failed charge — so a blip on
 * this write debited the workspace, failed the job, and let the retry charge again.
 *
 * It reports the outcome instead of throwing it: `consumeCredits` claims
 * `creditAlert80Sent` before calling, and a `false` here is how it learns to give that
 * claim back so a later debit re-attempts. Swallowing silently marked the alert sent and
 * lost it for the rest of the period.
 */
export async function notifyAdminsCredit80(input: {
  workspaceId: string;
  used: number;
  limit: number;
  periodStart: Date;
}) {
  try {
    const key = `credit-alert-80:${input.workspaceId}:${input.periodStart.toISOString()}`;
    const value = JSON.stringify({
      used: input.used,
      limit: input.limit,
      sentAt: new Date().toISOString(),
    });
    await prisma.appSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });

    const admins = await adminRecipients();
    // The send this function never did. Its two spend siblings have always called
    // `mailAdmins`; this one fetched the recipients, used the array for a log line and
    // returned `true`, so `consumeCredits` kept the `creditAlert80Sent` claim for an
    // email that never left the process. The first signal an admin got that the
    // workspace was running out was generation being denied.
    const delivery = await mailAdmins(admins, creditAlert80Email(input));
    console.info('[plans] 80% credit alert', {
      workspaceId: input.workspaceId,
      used: input.used,
      limit: input.limit,
      adminCount: admins.length,
      adminIds: admins.map((admin) => admin.id),
      sent: delivery.sent,
      failed: delivery.failed,
    });
    // A workspace with no active admin has nobody to warn, which is not a failed send:
    // returning `false` there would hand the claim back and re-attempt on every debit
    // for the rest of the period. Anything that was attempted and failed is.
    return delivery.failed === 0;
  } catch (error) {
    console.error('[plans] 80% credit alert failed', error);
    return false;
  }
}

export async function notifyAdminsSpend80(input: {
  workspaceId: string;
  used: number;
  limit: number;
}) {
  try {
    const key = `spend-alert-80:${input.workspaceId}`;
    const value = JSON.stringify({
      used: input.used,
      limit: input.limit,
      sentAt: new Date().toISOString(),
    });
    await prisma.appSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
    const admins = await adminRecipients();
    await mailAdmins(admins, spendAlert80Email(input));
    console.info('[plans] 80% spend alert', {
      workspaceId: input.workspaceId,
      used: input.used,
      limit: input.limit,
      adminCount: admins.length,
    });
  } catch (error) {
    console.error('[plans] 80% spend alert failed', error);
  }
}

export async function notifyAdminsSpendLimit(input: {
  workspaceId: string;
  used: number;
  limit: number;
}) {
  try {
    const admins = await adminRecipients();
    await mailAdmins(admins, spendLimitEmail(input));
    console.info('[plans] spend limit pause', {
      workspaceId: input.workspaceId,
      used: input.used,
      limit: input.limit,
      adminCount: admins.length,
    });
  } catch (error) {
    console.error('[plans] spend limit alert failed', error);
  }
}
