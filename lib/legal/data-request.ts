import { prisma } from '@/lib/db';
import { sendEmail } from '@/lib/email/client';
import { dataRequestEmail } from '@/lib/email/templates/data-request';

export async function requestAccountData(input: {
  userId: string;
  name: string;
  email: string;
  kind: 'export' | 'deletion';
  note?: string;
}) {
  const admins = await prisma.user.findMany({
    where: { role: 'ADMIN', isActive: true },
    select: { email: true },
  });
  const to = admins.map((row) => row.email).filter(Boolean);
  if (to.length === 0) {
    return { ok: false as const, error: 'No admin email is available', status: 503 };
  }

  const message = dataRequestEmail({
    requesterName: input.name,
    requesterEmail: input.email,
    kind: input.kind,
    note: input.note,
  });

  const results = await Promise.all(
    to.map((email) =>
      sendEmail({
        to: email,
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
    ),
  );

  if (results.every((result) => 'ok' in result && result.ok === false)) {
    return { ok: false as const, error: 'Could not email admins', status: 502 };
  }

  return { ok: true as const };
}
