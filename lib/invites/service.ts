import { randomBytes } from 'node:crypto';
import type { Prisma, Role } from '@/generated/prisma';
import { passwordChangeWrites } from '@/lib/auth/session-invalidation';
import { prisma } from '@/lib/db';
import { sendEmail, type SendEmailInput, type SendEmailResult } from '@/lib/email/client';
import { inviteEmail } from '@/lib/email/templates/invite';
import { log } from '@/lib/logger';
import { hashPassword, validateEmail, validatePassword } from '@/lib/password';
import { withLimit } from '@/lib/plans/limits';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { INVITE_TOKEN_TTL_MS, acceptInviteUrl, createInviteToken, hashInviteToken } from './tokens';

/**
 * The invite acceptance flow (F-351).
 *
 * Before this, `POST /api/admin/invite` created the User, wrote the `Invite` row with
 * `acceptedAt` already set, and returned a temporary password for the admin to relay
 * out-of-band. The invite row was a history note that gated nothing, the password travelled
 * over whatever channel the admin chose, and nothing ever made the invitee change it.
 *
 * Now the admin's action mails a single-use link and the invitee sets their own password.
 * The User row is still created at invite time, deliberately: the members ceiling is
 * enforced at the insert (F-307) and the Team page has to show who has been invited. What
 * the account does not have is a password anybody knows — its hash is of random bytes that
 * are discarded — so the link is the only way in, and `Invite.acceptedAt` is what says
 * whether it has been used.
 *
 * `tokenHash`, `expiresAt` and `revokedAt` are read and written with raw SQL for the reason
 * `lib/publish/repo-guard.ts` gives about `Deployment.githubRepoId`: the generated Prisma
 * client on a machine that has not re-run `prisma generate` predates the migration that
 * added them, and this flow has to work either way.
 */

export const EXPIRED_INVITE_MESSAGE = 'This invite link has expired or has already been used';
export const INVITE_ACCEPTED_MESSAGE = 'Password set — sign in';
export const MEMBER_EXISTS_MESSAGE = 'A member with that email already exists';
export const INVALID_EMAIL_MESSAGE = 'Enter a valid email address';

type EmailSend = (input: SendEmailInput) => Promise<SendEmailResult>;

export type InviteDeps = { send?: EmailSend; now?: Date };

export type InviteMemberRow = {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: Date;
};

export type IssuedInvite = {
  ok: true;
  member: InviteMemberRow;
  expiresAt: Date;
  /** False when the mail provider refused: the invite is real but nobody has the link. */
  emailed: boolean;
  emailError: string | null;
  /** True when this replaced an outstanding invite instead of creating a member. */
  resent: boolean;
};

export type InviteErr = { ok: false; error: string; status: number; details?: unknown };

export type PendingInvite = { ok: true; id: string; email: string; name: string; userId: string };

type InviteRow = {
  id: string;
  email: string;
  expiresAt: Date | null;
  acceptedAt: Date | null;
  revokedAt: Date | null;
};

/** Marks every outstanding invite for this address revoked. Returns how many. */
function revokeOutstanding(email: string, now: Date, client: Prisma.TransactionClient) {
  return client.$executeRaw`
    UPDATE "Invite"
    SET "revokedAt" = ${now}
    WHERE email = ${email} AND "acceptedAt" IS NULL AND "revokedAt" IS NULL
  `;
}

/** Attaches the token to the row `invite.create` just wrote, in the same transaction. */
function attachToken(
  client: Prisma.TransactionClient,
  inviteId: string,
  tokenHash: string,
  expiresAt: Date,
) {
  return client.$executeRaw`
    UPDATE "Invite" SET "tokenHash" = ${tokenHash}, "expiresAt" = ${expiresAt}
    WHERE id = ${inviteId}
  `;
}

async function outstandingInviteCount(email: string) {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count FROM "Invite"
    WHERE email = ${email} AND "acceptedAt" IS NULL AND "revokedAt" IS NULL
  `;
  return Number(rows[0]?.count ?? 0);
}

async function deliver(input: {
  to: string;
  acceptUrl: string;
  invitedByName: string | null;
  send: EmailSend;
}) {
  const mail = inviteEmail({ acceptUrl: input.acceptUrl, invitedByName: input.invitedByName });
  const result = await input.send({ to: input.to, ...mail });
  if ('ok' in result && result.ok === false) {
    // The pending invite is real either way; the caller reports this so the admin learns
    // the link never went out instead of assuming it did.
    log.error('invite.email_failed', { error: result.error });
    return { emailed: false, emailError: result.error };
  }
  return { emailed: true, emailError: null };
}

/**
 * Creates the pending invite (and, for a new address, the member row) and mails the link.
 *
 * Re-issuing for an address whose invite is still outstanding revokes the old link and
 * sends a new one — the only way to rotate a link that leaked or never arrived, and what
 * `revokedAt` is for. An address whose invite was already accepted is a member, and is
 * refused rather than re-invited.
 */
export async function issueInvite(
  input: {
    email: string;
    name?: string;
    role: Role;
    invitedById: string;
    workspaceId?: string;
  },
  deps?: InviteDeps,
): Promise<IssuedInvite | InviteErr> {
  const now = deps?.now ?? new Date();
  const send = deps?.send ?? sendEmail;
  const email = input.email.trim().toLowerCase();
  if (!validateEmail(email)) {
    return { ok: false, error: INVALID_EMAIL_MESSAGE, status: 400 };
  }
  const name = input.name?.trim() || email.split('@')[0];
  const rawToken = createInviteToken();
  const tokenHash = hashInviteToken(rawToken);
  const expiresAt = new Date(now.getTime() + INVITE_TOKEN_TTL_MS);

  const [inviter, existing] = await Promise.all([
    prisma.user.findUnique({ where: { id: input.invitedById }, select: { name: true } }),
    prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, name: true, role: true, createdAt: true },
    }),
  ]);

  let member: InviteMemberRow;
  let resent = false;

  if (existing) {
    if ((await outstandingInviteCount(email)) === 0) {
      return { ok: false, error: MEMBER_EXISTS_MESSAGE, status: 409 };
    }
    resent = true;
    member = existing;
    // No members reservation: this address is already counted against the ceiling.
    await prisma.$transaction(async (tx) => {
      await revokeOutstanding(email, now, tx);
      const invite = await tx.invite.create({
        data: { email, role: input.role, invitedById: input.invitedById },
        select: { id: true },
      });
      await attachToken(tx, invite.id, tokenHash, expiresAt);
    });
  } else {
    /**
     * A password nobody has. The account exists so the Team page and the members ceiling
     * can see it, but until the invite is accepted there is no string that opens it: this
     * hash is of 32 random bytes that go out of scope on the next line.
     */
    const passwordHash = await hashPassword(randomBytes(32).toString('base64url'));
    // bcrypt before the reservation: `withLimit` holds an advisory lock on the members
    // ceiling for the whole transaction, and a hash is ~100ms of CPU.
    const reserved = await withLimit(
      input.workspaceId ?? WORKSPACE_ROW_ID,
      'members',
      1,
      async (tx) => {
        const created = await tx.user.create({
          data: { email, name, role: input.role, passwordHash },
          select: { id: true, email: true, name: true, role: true, createdAt: true },
        });
        const invite = await tx.invite.create({
          data: { email, role: input.role, invitedById: input.invitedById },
          select: { id: true },
        });
        await attachToken(tx, invite.id, tokenHash, expiresAt);
        return created;
      },
    );
    if (!reserved.ok) {
      return {
        ok: false,
        error: reserved.message || 'Member limit reached',
        status: 402,
        details: { current: reserved.current, limit: reserved.limit, reason: reserved.reason },
      };
    }
    member = reserved.data;
  }

  const delivery = await deliver({
    to: email,
    acceptUrl: await acceptInviteUrl(rawToken),
    invitedByName: inviter?.name ?? null,
    send,
  });

  return { ok: true, member, expiresAt, resent, ...delivery };
}

/** Enough to decide whether to render the accept form. Never enough to skip the claim. */
export async function peekInviteToken(
  rawToken: string,
  now = new Date(),
): Promise<PendingInvite | { ok: false; error: string }> {
  const token = String(rawToken || '').trim();
  if (!token) return { ok: false, error: EXPIRED_INVITE_MESSAGE };

  const rows = await prisma.$queryRaw<InviteRow[]>`
    SELECT id, email, "expiresAt", "acceptedAt", "revokedAt"
    FROM "Invite" WHERE "tokenHash" = ${hashInviteToken(token)}
  `;
  const row = rows[0];
  if (
    !row ||
    row.acceptedAt ||
    row.revokedAt ||
    !row.expiresAt ||
    row.expiresAt.getTime() <= now.getTime()
  ) {
    return { ok: false, error: EXPIRED_INVITE_MESSAGE };
  }

  const user = await prisma.user.findUnique({
    where: { email: row.email },
    select: { id: true, name: true },
  });
  // The account this invite was written for is gone. There is nothing to accept, and
  // minting a user here would let a stale link create an account.
  if (!user) return { ok: false, error: EXPIRED_INVITE_MESSAGE };

  return { ok: true, id: row.id, email: row.email, name: user.name, userId: user.id };
}

export type AcceptOk = { ok: true; message: string; email: string };

export async function acceptInviteWithToken(
  input: { token: string; password: string },
  deps?: { now?: Date },
): Promise<AcceptOk | { ok: false; error: string }> {
  const now = deps?.now ?? new Date();
  const passwordCheck = validatePassword(input.password);
  if (!passwordCheck.ok) return passwordCheck;

  const peeked = await peekInviteToken(input.token, now);
  if (!peeked.ok) return peeked;

  const passwordHash = await hashPassword(input.password);

  /**
   * The peek above is only good enough to render a form: between it and the write, a
   * second request carrying the same link passes the same check. The claim is therefore
   * the row count of a conditional UPDATE inside the transaction that sets the password —
   * the shape `resetPasswordWithToken` uses, for the reason F-745 recorded: a re-read
   * races, a count cannot. Zero rows means somebody else used the link first, and nothing
   * else in the transaction runs.
   */
  const claimed = await prisma.$transaction(async (tx) => {
    const count = await tx.$executeRaw`
      UPDATE "Invite" SET "acceptedAt" = ${now}
      WHERE id = ${peeked.id} AND "acceptedAt" IS NULL AND "revokedAt" IS NULL
    `;
    if (count === 0) return false;
    await Promise.all(passwordChangeWrites(peeked.userId, passwordHash, now, tx));
    // Any other outstanding link for this address is spent too: one account, one accept.
    await revokeOutstanding(peeked.email, now, tx);
    return true;
  });
  if (!claimed) return { ok: false, error: EXPIRED_INVITE_MESSAGE };

  const { writeAudit } = await import('@/lib/audit/log');
  await writeAudit({
    actorId: peeked.userId,
    actorEmail: peeked.email,
    action: 'invite.accepted',
    targetType: 'user',
    targetId: peeked.userId,
  });

  return { ok: true, message: INVITE_ACCEPTED_MESSAGE, email: peeked.email };
}

/** Addresses with a live pending invite, so the Team page can say who has not accepted. */
export async function pendingInviteEmails(now = new Date()): Promise<Set<string>> {
  const rows = await prisma.$queryRaw<Array<{ email: string }>>`
    SELECT DISTINCT email FROM "Invite"
    WHERE "acceptedAt" IS NULL AND "revokedAt" IS NULL AND "expiresAt" > ${now}
  `;
  return new Set(rows.map((row) => row.email));
}
