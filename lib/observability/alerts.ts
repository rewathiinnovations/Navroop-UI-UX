import { sendEmail } from '../email/client';
import type { ObservabilityEmail, SendAdminEmail } from './types';

export async function sendObservabilityAdminEmail(mail: ObservabilityEmail) {
  const { prisma } = await import('../db');
  const admins = await prisma.user.findMany({
    where: { role: 'ADMIN', isActive: true },
    select: { email: true },
  });
  for (const admin of admins) {
    if (!admin.email) continue;
    await sendEmail({
      to: admin.email,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      emailClass: mail.emailClass ?? 'security',
    });
  }
}

export function resolveSendAdminEmail(override?: SendAdminEmail): SendAdminEmail {
  return override ?? sendObservabilityAdminEmail;
}
