import { prisma } from '@/lib/db';
import { sendEmail } from '@/lib/email/client';
import { spendAlert80Email, spendLimitEmail } from '@/lib/email/templates/spend-alert';

async function adminRecipients() {
  return prisma.user.findMany({
    where: { role: 'ADMIN', isActive: true },
    select: { id: true, email: true },
  });
}

async function mailAdmins(
  admins: Array<{ email: string }>,
  template: { subject: string; html: string; text: string },
) {
  for (const admin of admins) {
    if (!admin.email) continue;
    await sendEmail({ to: admin.email, ...template }).catch(() => undefined);
  }
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
    console.info('[plans] 80% credit alert', {
      workspaceId: input.workspaceId,
      used: input.used,
      limit: input.limit,
      adminCount: admins.length,
      adminIds: admins.map((admin) => admin.id),
    });
    return true;
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
