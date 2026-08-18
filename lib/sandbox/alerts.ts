import { prisma } from '@/lib/db';
import { sendEmail } from '@/lib/email/client';
import {
  oneTimeExhaustedEmail,
  oneTimeLowEmail,
  recurringCredit80Email,
} from '@/lib/email/templates/sandbox-credits';
import type { CreditAlert } from './credits';

async function adminRecipients() {
  return prisma.user.findMany({
    where: { role: 'ADMIN', isActive: true },
    select: { email: true },
  });
}

async function mailAdmins(template: { subject: string; html: string; text: string }) {
  const admins = await adminRecipients();
  for (const admin of admins) {
    if (!admin.email) continue;
    await sendEmail({ to: admin.email, ...template }).catch(() => undefined);
  }
}

async function once(key: string) {
  const existing = await prisma.appSetting.findUnique({ where: { key } });
  if (existing) return false;
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  });
  return true;
}

export async function notifyProviderAlerts(
  alerts: CreditAlert[],
  input: { id: string; name: string; remainingUsd: number; totalUsd: number; monthsRemaining: number | null },
) {
  try {
    if (alerts.includes('recurring_80')) {
      await mailAdmins(
        recurringCredit80Email({
          name: input.name,
          remainingUsd: input.remainingUsd,
          totalUsd: input.totalUsd,
        }),
      );
    }
    if (alerts.includes('one_time_low')) {
      const first = await once(`sandbox.one-time-low:${input.id}`);
      if (first) {
        await mailAdmins(
          oneTimeLowEmail({
            name: input.name,
            remainingUsd: input.remainingUsd,
            monthsRemaining: input.monthsRemaining ?? Number.POSITIVE_INFINITY,
          }),
        );
      }
    }
    if (alerts.includes('one_time_exhausted')) {
      await mailAdmins(oneTimeExhaustedEmail({ name: input.name }));
    }
  } catch (error) {
    console.error('[sandbox] credit alert failed', error);
  }
}
