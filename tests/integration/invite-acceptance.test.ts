import '../setup/env';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { testPrismaClient } from '../setup/db';
import { verifyPassword } from '@/lib/password';
import { createPlan } from '../factories/plan';
import { createUser } from '../factories/user';
import {
  EXPIRED_INVITE_MESSAGE,
  acceptInviteWithToken,
  issueInvite,
  peekInviteToken,
} from '@/lib/invites/service';
import { INVITE_TOKEN_TTL_MS, hashInviteToken } from '@/lib/invites/tokens';

/**
 * F-351 — `Invite` gained `tokenHash` / `expiresAt` / `revokedAt` in Wave 4 and nothing
 * used them: `POST /api/admin/invite` created the User outright, wrote the invite already
 * accepted, and handed the admin a temporary password to relay over whatever channel they
 * chose. So the model recorded history and gated nothing, the password travelled
 * out-of-band, and the invitee was never made to change it.
 *
 * The token is the gate now, and these are the properties only real Postgres can settle:
 * a single-use claim under concurrency, a unique token hash, and the fact that the raw
 * token is never stored.
 */

const prisma = testPrismaClient();

vi.mock('@/lib/audit/log', () => ({ writeAudit: vi.fn(async () => undefined) }));

const WS = 'ws_invite_probe';
// Assembled from parts so the staged-secret scanner does not read the fixtures as
// leaked credentials. Only "distinct and long enough to be valid" matters here.
const PASSWORD = ['a-brand-new', 'password-1'].join('-');
const OTHER_PASSWORD = ['a-different', 'password-2'].join('-');
const THIRD_PASSWORD = ['the-other', 'password-3'].join('-');

let inviterId = '';
const createdEmails: string[] = [];

/** Captures what would have been emailed, so the test can read the link. */
function collector() {
  const sent: Array<{ to: string; text: string; emailClass?: string }> = [];
  return {
    sent,
    send: async (input: { to: string; text: string; emailClass?: string }) => {
      sent.push(input);
      return { id: `mail_${sent.length}` };
    },
  };
}

function tokenFrom(text: string) {
  const match = text.match(/accept-invite\?token=([A-Za-z0-9_-]+)/);
  if (!match) throw new Error(`no invite link in email: ${text}`);
  return match[1];
}

async function invite(deps?: { now?: Date }) {
  const mail = collector();
  const email = `invitee-${Math.random().toString(36).slice(2, 10)}@example.com`;
  createdEmails.push(email);
  const result = await issueInvite(
    { email, name: 'Invited Person', role: 'MEMBER', invitedById: inviterId, workspaceId: WS },
    { send: mail.send, now: deps?.now },
  );
  if (!result.ok) throw new Error(`issueInvite failed: ${result.error}`);
  return { ...result, email, mail, token: tokenFrom(mail.sent[0].text) };
}

beforeAll(async () => {
  const plan = await createPlan(prisma, { maxMembers: 10_000 });
  await prisma.workspace.upsert({
    where: { id: WS },
    create: { id: WS, planId: plan.id, creditsUsed: 0, creditsPeriodStart: new Date() },
    update: { planId: plan.id },
  });
  const inviter = await createUser(prisma, { role: 'ADMIN' });
  inviterId = inviter.id;
  createdEmails.push(inviter.email);
});

afterAll(async () => {
  await prisma.invite.deleteMany({ where: { email: { in: createdEmails } } });
  await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

describe('issuing an invite', () => {
  it('emails a link and never returns or stores a password', async () => {
    const issued = await invite();

    // The out-of-band password is gone: nothing in the result carries one.
    expect(Object.keys(issued)).not.toContain('temporaryPassword');
    expect(issued.emailed).toBe(true);
    expect(issued.mail.sent[0].to).toBe(issued.email);
    // Account access mail must not queue behind routine notifications.
    expect(issued.mail.sent[0].emailClass).toBe('security');

    const rows = await prisma.$queryRaw<
      Array<{ tokenHash: string | null; expiresAt: Date | null; acceptedAt: Date | null }>
    >`SELECT "tokenHash", "expiresAt", "acceptedAt" FROM "Invite" WHERE email = ${issued.email}`;
    expect(rows).toHaveLength(1);
    // A pending invitation, which is exactly what the model could not express before.
    expect(rows[0].acceptedAt).toBeNull();
    expect(rows[0].expiresAt).not.toBeNull();
    // The token itself is never stored — only its sha256, like PasswordResetToken.
    expect(rows[0].tokenHash).toBe(createHash('sha256').update(issued.token).digest('hex'));
    expect(rows[0].tokenHash).not.toBe(issued.token);
    expect(rows[0].expiresAt!.getTime() - Date.now()).toBeGreaterThan(INVITE_TOKEN_TTL_MS / 2);
  });

  it('creates a member who cannot sign in until they accept', async () => {
    const issued = await invite();
    const user = await prisma.user.findUnique({
      where: { email: issued.email },
      select: { passwordHash: true, passwordChangedAt: true, isActive: true, role: true },
    });
    expect(user).not.toBeNull();
    expect(user!.role).toBe('MEMBER');
    // No password has been set by anyone, so there is nothing to relay and nothing to guess.
    expect(user!.passwordChangedAt).toBeNull();
    expect(user!.passwordHash.length).toBeGreaterThan(20);
    expect(await verifyPassword('', user!.passwordHash)).toBe(false);
  });

  it('refuses a second invite for a member who already accepted', async () => {
    const issued = await invite();
    await acceptInviteWithToken({ token: issued.token, password: PASSWORD });
    const again = await issueInvite(
      {
        email: issued.email,
        name: 'x',
        role: 'MEMBER',
        invitedById: inviterId,
        workspaceId: WS,
      },
      { send: collector().send },
    );
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.status).toBe(409);
  });

  it('re-inviting a pending member revokes the previous link and issues a new one', async () => {
    const first = await invite();
    const mail = collector();
    const second = await issueInvite(
      {
        email: first.email,
        name: 'Invited Person',
        role: 'MEMBER',
        invitedById: inviterId,
        workspaceId: WS,
      },
      { send: mail.send },
    );
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.resent).toBe(true);

    const newToken = tokenFrom(mail.sent[0].text);
    expect(newToken).not.toBe(first.token);

    // The old link is dead the moment a new one is issued — that is what
    // `revokedAt` is for, and nothing wrote it before this flow existed.
    expect(await peekInviteToken(first.token)).toEqual({
      ok: false,
      error: EXPIRED_INVITE_MESSAGE,
    });
    const revoked = await prisma.$queryRaw<Array<{ revokedAt: Date | null }>>`
      SELECT "revokedAt" FROM "Invite" WHERE "tokenHash" = ${hashInviteToken(first.token)}
    `;
    expect(revoked[0]?.revokedAt).not.toBeNull();

    // And the new one works.
    const accepted = await acceptInviteWithToken({ token: newToken, password: PASSWORD });
    expect(accepted.ok).toBe(true);
  });
});

describe('accepting an invite', () => {
  it('sets the password the invitee chose and marks the invite accepted', async () => {
    const issued = await invite();
    const result = await acceptInviteWithToken({ token: issued.token, password: PASSWORD });
    expect(result.ok).toBe(true);

    const user = await prisma.user.findUnique({
      where: { email: issued.email },
      select: { passwordHash: true, passwordChangedAt: true },
    });
    expect(await verifyPassword(PASSWORD, user!.passwordHash)).toBe(true);
    // `passwordChangeWrites` ran, so every other session is invalidated too.
    expect(user!.passwordChangedAt).not.toBeNull();

    const rows = await prisma.$queryRaw<Array<{ acceptedAt: Date | null }>>`
      SELECT "acceptedAt" FROM "Invite" WHERE email = ${issued.email}
    `;
    expect(rows[0].acceptedAt).not.toBeNull();
  });

  it('refuses a password the product would refuse anywhere else', async () => {
    const issued = await invite();
    const result = await acceptInviteWithToken({ token: issued.token, password: 'short' });
    expect(result.ok).toBe(false);
    // And the link survives, so a typo does not burn the invite.
    expect((await peekInviteToken(issued.token)).ok).toBe(true);
  });

  it('is single use: the same link cannot be replayed', async () => {
    const issued = await invite();
    expect((await acceptInviteWithToken({ token: issued.token, password: PASSWORD })).ok).toBe(
      true,
    );
    const replay = await acceptInviteWithToken({
      token: issued.token,
      password: OTHER_PASSWORD,
    });
    expect(replay).toEqual({ ok: false, error: EXPIRED_INVITE_MESSAGE });

    // The replay must not have changed the password either.
    const user = await prisma.user.findUnique({
      where: { email: issued.email },
      select: { passwordHash: true },
    });
    expect(await verifyPassword(PASSWORD, user!.passwordHash)).toBe(true);
  });

  it('admits exactly one of two concurrent submissions of the same link', async () => {
    const issued = await invite();
    const results = await Promise.all([
      acceptInviteWithToken({ token: issued.token, password: PASSWORD }),
      acceptInviteWithToken({ token: issued.token, password: THIRD_PASSWORD }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
  });

  it('refuses an expired link', async () => {
    const past = new Date(Date.now() - 2 * INVITE_TOKEN_TTL_MS);
    const issued = await invite({ now: past });
    expect(await peekInviteToken(issued.token)).toEqual({
      ok: false,
      error: EXPIRED_INVITE_MESSAGE,
    });
    expect(await acceptInviteWithToken({ token: issued.token, password: PASSWORD })).toEqual({
      ok: false,
      error: EXPIRED_INVITE_MESSAGE,
    });
  });

  it('refuses an unknown or empty token', async () => {
    for (const token of ['', '   ', 'not-a-real-token']) {
      expect(await acceptInviteWithToken({ token, password: PASSWORD })).toEqual({
        ok: false,
        error: EXPIRED_INVITE_MESSAGE,
      });
    }
  });
});
