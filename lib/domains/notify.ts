import { prisma } from '@/lib/db';
import { sendEmail } from '@/lib/email/client';
import { customDomainFailedEmail } from '@/lib/email/templates/custom-domain-failed';
import { customDomainDnsEmail } from '@/lib/email/templates/custom-domain-dns';
import { instructionsPlainText } from './instructions';
import { DNS_PROPAGATION_NOTE, PATH_B_COPY, type CustomDomainRow, type DnsInstruction } from './types';

export async function notifyDomainFailed(row: CustomDomainRow) {
  const key = `custom-domain-failed:${row.id}`;
  const value = JSON.stringify({
    hostname: row.hostname,
    lastError: row.lastError,
    sentAt: new Date().toISOString(),
  });
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });

  const admins = await prisma.user.findMany({
    where: { role: 'ADMIN', isActive: true },
    select: { email: true },
  });
  const mail = customDomainFailedEmail({
    hostname: row.hostname,
    lastError: row.lastError || 'DNS did not match the expected records within 7 days.',
  });
  for (const admin of admins) {
    if (!admin.email) continue;
    await sendEmail({ to: admin.email, ...mail });
  }
}

export async function emailDomainInstructions(input: {
  to: string;
  hostname: string;
  path: 'A' | 'B';
  instructions: DnsInstruction[];
}) {
  const mail = customDomainDnsEmail({
    hostname: input.hostname,
    path: input.path,
    table: instructionsPlainText(input.instructions),
    note: input.path === 'B' ? PATH_B_COPY : DNS_PROPAGATION_NOTE,
  });
  return sendEmail({ to: input.to, ...mail });
}
