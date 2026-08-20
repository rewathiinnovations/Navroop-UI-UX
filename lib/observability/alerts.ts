import { sendEmail } from '../email/client';
import { log } from '../logger';
import type { ObservabilityEmail, SendAdminEmail } from './types';

export type AdminEmailDeps = {
  listAdminEmails?: () => Promise<string[]>;
  send?: typeof sendEmail;
};

export type AdminEmailResult = { sent: number; failed: string[] };

/**
 * Observability mail is `emailClass: 'security'` and therefore exempt from the
 * per-recipient rate-limit bucket, so every one of these sends leaves the building. The
 * old serial `for` loop also discarded each `SendEmailResult`, so an admin address that
 * the provider rejected produced no record anywhere — the one thing worth knowing about
 * a security email is that it did not arrive (F-739).
 */
export async function sendObservabilityAdminEmail(
  mail: ObservabilityEmail,
  deps: AdminEmailDeps = {},
): Promise<AdminEmailResult> {
  const listAdminEmails =
    deps.listAdminEmails ??
    (async () => {
      // Deliberately dynamic, as it was before: this module is imported from boot paths
      // and from the edge runtime bundle, and a static `lib/db` import would drag the
      // Prisma client in wherever it is reachable.
      const { prisma } = await import('../db');
      const admins = await prisma.user.findMany({
        where: { role: 'ADMIN', isActive: true },
        select: { email: true },
      });
      return admins.map((admin) => admin.email).filter((email): email is string => Boolean(email));
    });
  const send = deps.send ?? sendEmail;
  const recipients = await listAdminEmails();
  // `sendEmail` is documented never to throw, so `allSettled` is belt-and-braces; what it
  // buys is that a future transport which does throw cannot take the fan-out with it.
  const results = await Promise.allSettled(
    recipients.map((to) =>
      send({
        to,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        emailClass: mail.emailClass ?? 'security',
      }),
    ),
  );
  const failed: string[] = [];
  for (const [index, result] of results.entries()) {
    const to = recipients[index]!;
    if (result.status === 'rejected') {
      failed.push(to);
      log.error('observability.admin_email_threw', {
        to,
        subject: mail.subject,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
      continue;
    }
    // `SendEmailResult` is `{ id } | { ok: false; error }` — the success arm has no `ok`
    // field at all, so the presence of the discriminant is the failure.
    if ('ok' in result.value) {
      failed.push(to);
      log.error('observability.admin_email_failed', {
        to,
        subject: mail.subject,
        error: result.value.error,
      });
    }
  }
  return { sent: recipients.length - failed.length, failed };
}

export function resolveSendAdminEmail(override?: SendAdminEmail): SendAdminEmail {
  // Wrapped rather than passed through: the fan-out reports which recipients failed, and
  // `SendAdminEmail` is the narrower "just send it" seam the callers are typed against.
  return (
    override ??
    (async (mail) => {
      await sendObservabilityAdminEmail(mail);
    })
  );
}
