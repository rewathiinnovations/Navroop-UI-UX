import { prisma } from '@/lib/db';
import { sendEmail } from '@/lib/email/client';
import { customDomainFailedEmail } from '@/lib/email/templates/custom-domain-failed';
import { customDomainDnsEmail } from '@/lib/email/templates/custom-domain-dns';
import { instructionsPlainText } from './instructions';
import { appPublicUrl } from '@/lib/settings/app-url';
import { domainFailureRecipients } from './recipients';
import {
  DNS_PROPAGATION_NOTE,
  PATH_B_COPY,
  type CustomDomainRow,
  type DnsInstruction,
} from './types';

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

  // F-263: this used to stop at the admins. The owner is the only person who can change a
  // record at the registrar, and `CustomDomain` records no `createdById` — the deployment's
  // publisher and the project's owner are the two people the schema does name.
  const deployment = await prisma.deployment.findUnique({
    where: { id: row.deploymentId },
    select: {
      projectId: true,
      project: { select: { name: true, owner: { select: { email: true } } } },
      publishedBy: { select: { email: true } },
    },
  });
  const admins = await prisma.user.findMany({
    where: { role: 'ADMIN', isActive: true },
    select: { email: true },
  });
  const recipients = domainFailureRecipients({
    ownerEmail: deployment?.project.owner.email,
    publisherEmail: deployment?.publishedBy.email,
    adminEmails: admins.map((admin) => admin.email),
  });
  if (recipients.length === 0) return;

  const mail = customDomainFailedEmail({
    hostname: row.hostname,
    lastError: row.lastError || 'DNS did not match the expected records within 7 days.',
    projectName: deployment?.project.name ?? null,
    // The page the hostname was added on, so the mail is actionable rather than a report.
    domainsUrl: deployment
      ? `${await appPublicUrl()}/project/${deployment.projectId}/domains`
      : null,
  });
  for (const to of recipients) {
    await sendEmail({ to, ...mail });
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
