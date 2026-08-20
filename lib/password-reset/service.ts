import { prisma } from '@/lib/db';
import { passwordChangeWrites } from '@/lib/auth/session-invalidation';
import { sendEmail, type SendEmailInput, type SendEmailResult } from '@/lib/email/client';
import { passwordChangedEmail } from '@/lib/email/templates/password-changed';
import { passwordResetEmail } from '@/lib/email/templates/password-reset';
import { hashPassword, validateEmail, validatePassword } from '@/lib/password';
import { allowPasswordResetRequest } from '@/lib/password-reset/rate-limit';
import {
  RESET_TOKEN_TTL_MS,
  createResetToken,
  hashResetToken,
  resetPasswordUrl,
} from '@/lib/password-reset/tokens';

export const GENERIC_FORGOT_MESSAGE =
  'If this email is registered, a link has been sent. Check inbox and spam.';

export const RESET_SUCCESS_MESSAGE = 'Password updated — sign in';
export const EXPIRED_RESET_MESSAGE = 'This link has expired';

type EmailSend = (input: SendEmailInput) => Promise<SendEmailResult>;

export type ForgotResult = { ok: true; message: string };
export type ResetOk = { ok: true; message: string };
export type ResetErr = { ok: false; error: string };

async function dummyWork() {
  await hashPassword('timing-dummy-password');
}

async function invalidateUnusedTokens(userId: string, now: Date) {
  await prisma.passwordResetToken.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt: now },
  });
}

async function issueAndEmail(user: { id: string; email: string }, now: Date, send: EmailSend) {
  await invalidateUnusedTokens(user.id, now);
  const raw = createResetToken();
  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hashResetToken(raw),
      expiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_MS),
    },
  });
  const mail = passwordResetEmail(await resetPasswordUrl(raw));
  const result = await send({ to: user.email, ...mail });
  if ('ok' in result && result.ok === false) {
    console.error('[password-reset] email failed:', result.error);
  }
  const { writeAudit } = await import('@/lib/audit/log');
  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: 'password_reset.requested',
    targetType: 'user',
    targetId: user.id,
  });
}

export async function requestPasswordReset(
  input: { email: string; ip: string | null },
  deps?: { send?: EmailSend; now?: Date },
): Promise<ForgotResult> {
  const email = String(input.email || '')
    .trim()
    .toLowerCase();
  const now = deps?.now ?? new Date();
  const send = deps?.send ?? sendEmail;

  if (!validateEmail(email)) {
    await dummyWork();
    return { ok: true, message: GENERIC_FORGOT_MESSAGE };
  }

  // No dummyWork here (F-709): the response is byte-identical either way, so
  // there is no timing signal to equalise — and burning a cost-12 bcrypt for a
  // request the limiter already refused makes the flood *more* expensive to
  // serve, not less.
  if (!allowPasswordResetRequest(email, input.ip, now)) {
    return { ok: true, message: GENERIC_FORGOT_MESSAGE };
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, isActive: true },
  });

  if (!user || !user.isActive) {
    await dummyWork();
    return { ok: true, message: GENERIC_FORGOT_MESSAGE };
  }

  await issueAndEmail(user, now, send);
  return { ok: true, message: GENERIC_FORGOT_MESSAGE };
}

export async function sendPasswordResetForUser(
  userId: string,
  deps?: { send?: EmailSend; now?: Date },
): Promise<ForgotResult | ResetErr> {
  const now = deps?.now ?? new Date();
  const send = deps?.send ?? sendEmail;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, isActive: true },
  });
  if (!user) return { ok: false, error: 'User not found' };
  if (!user.isActive) {
    return { ok: false, error: 'Inactive member — reactivate first' };
  }
  await issueAndEmail(user, now, send);
  return { ok: true, message: GENERIC_FORGOT_MESSAGE };
}

export async function peekResetToken(rawToken: string, now = new Date()) {
  const token = String(rawToken || '').trim();
  if (!token) return { ok: false as const, error: EXPIRED_RESET_MESSAGE };

  const row = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashResetToken(token) },
    select: { id: true, userId: true, expiresAt: true, usedAt: true },
  });
  if (!row || row.usedAt || row.expiresAt.getTime() <= now.getTime()) {
    return { ok: false as const, error: EXPIRED_RESET_MESSAGE };
  }
  return { ok: true as const, id: row.id, userId: row.userId };
}

export async function resetPasswordWithToken(
  input: { token: string; password: string },
  deps?: { send?: EmailSend; now?: Date },
): Promise<ResetOk | ResetErr> {
  const now = deps?.now ?? new Date();
  const send = deps?.send ?? sendEmail;
  const passwordCheck = validatePassword(input.password);
  if (!passwordCheck.ok) return passwordCheck;

  const peeked = await peekResetToken(input.token, now);
  if (!peeked.ok) return peeked;

  const passwordHash = await hashPassword(input.password);

  await prisma.$transaction([
    ...passwordChangeWrites(peeked.userId, passwordHash, now),
    prisma.passwordResetToken.update({
      where: { id: peeked.id },
      data: { usedAt: now },
    }),
    prisma.passwordResetToken.updateMany({
      where: { userId: peeked.userId, id: { not: peeked.id }, usedAt: null },
      data: { usedAt: now },
    }),
  ]);

  const user = await prisma.user.findUnique({
    where: { id: peeked.userId },
    select: { email: true },
  });
  if (user?.email) {
    const mail = passwordChangedEmail();
    const result = await send({ to: user.email, ...mail });
    if ('ok' in result && result.ok === false) {
      console.error('[password-reset] passwordChanged email failed:', result.error);
    }
  }

  const { writeAudit } = await import('@/lib/audit/log');
  await writeAudit({
    actorId: peeked.userId,
    actorEmail: user?.email || 'unknown',
    action: 'password_reset.completed',
    targetType: 'user',
    targetId: peeked.userId,
  });

  return { ok: true, message: RESET_SUCCESS_MESSAGE };
}
