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

export async function notifyAdminsCredit80(input: {
  workspaceId: string;
  used: number;
  limit: number;
  periodStart: Date;
}) {
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
