import { prisma } from '@/lib/db';
import { TERMS_REQUIRED_MESSAGE, TERMS_VERSION } from './terms';

/**
 * Terms acceptance for an account an admin already created.
 *
 * This module used to export `registerAccount`, which minted a MEMBER for anyone who
 * posted a form to `POST /api/auth/register` — and because project reads are
 * workspace-wide by design, a self-registered stranger could read every project in the
 * workspace. The first fix gated it on a pending `Invite` row for the submitted email.
 * That gate was unsatisfiable at the time: the only invite producer,
 * `POST /api/admin/invite`, wrote the row with `acceptedAt` already set and created the
 * User (plus a temporary password) itself, so no claimable invite existed. The endpoint
 * therefore answered 403 to everyone, forever, while the auth modal still offered the
 * form. Navroop is invite-only (see `.cursor/rules/navroop-product.mdc`), so the endpoint
 * is now closed outright rather than guarded by a control that cannot fire, and the
 * registration code is gone rather than left here looking live.
 *
 * What is left is the invitee's own path, and it is a real one now: `POST /api/admin/invite`
 * mails a single-use invite link, the invitee sets their own password at `/accept-invite`
 * (F-351), and their acceptance of the current terms is read and recorded through
 * `GET`/`POST /api/legal/accept`, the only caller of the two functions below.
 */

export { TERMS_VERSION, TERMS_REQUIRED_MESSAGE };

export async function acceptTermsForUser(userId: string) {
  const acceptedAt = new Date();
  await prisma.$executeRaw`
    UPDATE "User"
    SET "termsAcceptedAt" = ${acceptedAt}, "termsVersion" = ${TERMS_VERSION}
    WHERE id = ${userId}
  `;
  return { termsAcceptedAt: acceptedAt, termsVersion: TERMS_VERSION };
}

export async function getTermsStatus(userId: string) {
  const rows = await prisma.$queryRaw<
    Array<{ termsAcceptedAt: Date | null; termsVersion: string | null }>
  >`
    SELECT "termsAcceptedAt", "termsVersion" FROM "User" WHERE id = ${userId}
  `;
  const row = rows[0];
  return {
    termsAcceptedAt: row?.termsAcceptedAt ?? null,
    termsVersion: row?.termsVersion ?? null,
    currentVersion: TERMS_VERSION,
  };
}
