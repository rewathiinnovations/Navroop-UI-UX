/**
 * Password reset + email client.
 * Run: pnpm exec tsx tests/password-reset.test.ts
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { testPrismaClient } from './setup/db.ts';
import { sendEmail } from '../lib/email/client.ts';
import { hashPassword, verifyPassword } from '../lib/password.ts';
import {
  GENERIC_FORGOT_MESSAGE,
  requestPasswordReset,
  resetPasswordWithToken,
} from '../lib/password-reset/service.ts';

config({ path: resolve(process.cwd(), '.env.local') });
config({ path: resolve(process.cwd(), '.env') });

const prisma = testPrismaClient();

let failed = 0;
let passed = 0;

function assert(cond: unknown, name: string) {
  if (cond) {
    passed += 1;
    console.log(`PASS  ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL  ${name}`);
}

function hashToken(raw: string) {
  return createHash('sha256').update(raw).digest('hex');
}

function tokenFromEmail(text: string) {
  const match = text.match(/reset-password\?token=([A-Za-z0-9_-]+)/);
  return match?.[1] ?? null;
}

type CapturedEmail = { to: string; subject: string; html: string; text: string };

function captureSender() {
  const sent: CapturedEmail[] = [];
  const send = async (input: CapturedEmail) => {
    sent.push(input);
    return { id: `test_${sent.length}` };
  };
  return { sent, send };
}

// --- email client (dev driver) ---

{
  const prevKey = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;

  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };

  try {
    const result = await sendEmail({
      to: 'dev@example.com',
      subject: 'Reset',
      html: '<p>http://localhost:3000/reset-password?token=devtoken123</p>',
      text: 'http://localhost:3000/reset-password?token=devtoken123',
    });
    console.log = origLog;
    assert('id' in result && typeof result.id === 'string', 'dev driver returns id');
    assert(logs.some((line) => line.includes('reset-password?token=')), 'dev driver prints the reset link');
  } catch (error) {
    console.log = origLog;
    failed += 1;
    console.error('FAIL  dev driver returns id / prints link');
    origError.call(console, error);
  }

  try {
    console.log = () => {
      throw new Error('console boom');
    };
    const result = await sendEmail({
      to: 'dev@example.com',
      subject: 'Reset',
      html: '<p>hi</p>',
      text: 'hi',
    });
    console.log = origLog;
    assert('ok' in result && result.ok === false, 'dev driver never throws — failed result on log error');
  } catch {
    console.log = origLog;
    failed += 1;
    console.error('FAIL  dev driver never throws — failed result on log error');
  }

  console.log = origLog;
  console.error = origError;
  if (prevKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = prevKey;
}

// --- password reset service ---

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
const knownEmail = `pr-known-${suffix}@example.com`;
const unknownEmail = `pr-unknown-${suffix}@example.com`;
const inactiveEmail = `pr-inactive-${suffix}@example.com`;
const userIds: string[] = [];

try {
  const known = await prisma.user.create({
    data: {
      email: knownEmail,
      name: 'Reset Known',
      passwordHash: await hashPassword('OldPass123'),
      role: 'MEMBER',
    },
  });
  userIds.push(known.id);

  const inactive = await prisma.user.create({
    data: {
      email: inactiveEmail,
      name: 'Reset Inactive',
      passwordHash: await hashPassword('OldPass123'),
      role: 'MEMBER',
      isActive: false,
    },
  });
  userIds.push(inactive.id);

  const knownCap = captureSender();
  const unknownCap = captureSender();
  const knownResult = await requestPasswordReset(
    { email: knownEmail, ip: '10.0.0.1' },
    { send: knownCap.send },
  );
  const unknownResult = await requestPasswordReset(
    { email: unknownEmail, ip: '10.0.0.2' },
    { send: unknownCap.send },
  );

  assert(knownResult.ok === true && unknownResult.ok === true, 'known and unknown both ok');
  assert(
    knownResult.message === unknownResult.message && knownResult.message === GENERIC_FORGOT_MESSAGE,
    'identical success body for unknown vs known email',
  );
  assert(JSON.stringify(knownResult) === JSON.stringify(unknownResult), 'identical success JSON for unknown vs known');
  assert(knownCap.sent.length === 1, 'known active user is emailed');
  assert(unknownCap.sent.length === 0, 'unknown email is not emailed');

  const inactiveCap = captureSender();
  const inactiveResult = await requestPasswordReset(
    { email: inactiveEmail, ip: '10.0.0.3' },
    { send: inactiveCap.send },
  );
  assert(
    inactiveResult.ok && inactiveResult.message === GENERIC_FORGOT_MESSAGE,
    'inactive user gets generic success',
  );
  assert(inactiveCap.sent.length === 0, 'inactive user is not emailed');

  const raw = tokenFromEmail(knownCap.sent[0]?.text ?? '');
  assert(Boolean(raw), 'reset email contains a tokenized link');

  if (raw) {
    const rows = await prisma.passwordResetToken.findMany({ where: { userId: known.id } });
    assert(rows.length === 1, 'one token row stored');
    assert(
      rows.every((row) => row.tokenHash === hashToken(raw) && row.tokenHash !== raw),
      'raw token not stored — only sha256 hash',
    );

    await prisma.session.create({
      data: {
        sessionToken: `sess_${suffix}`,
        userId: known.id,
        expires: new Date(Date.now() + 86_400_000),
      },
    });

    const first = await resetPasswordWithToken({ token: raw, password: 'NewPass123' });
    assert(first.ok === true, 'first use of token succeeds');

    const updated = await prisma.user.findUnique({ where: { id: known.id } });
    assert(
      Boolean(updated && (await verifyPassword('NewPass123', updated.passwordHash))),
      'password hash updated',
    );
    const sessionsLeft = await prisma.session.count({ where: { userId: known.id } });
    assert(sessionsLeft === 0, 'existing sessions destroyed after reset');

    const second = await resetPasswordWithToken({ token: raw, password: 'OtherPass123' });
    assert(second.ok === false, 'second use of token fails');
  }

  const expiredCap = captureSender();
  const expiredUser = await prisma.user.create({
    data: {
      email: `pr-expired-${suffix}@example.com`,
      name: 'Reset Expired',
      passwordHash: await hashPassword('OldPass123'),
      role: 'MEMBER',
    },
  });
  userIds.push(expiredUser.id);

  const issuedAt = new Date('2026-01-01T00:00:00.000Z');
  await requestPasswordReset(
    { email: expiredUser.email, ip: '10.0.0.4' },
    { send: expiredCap.send, now: issuedAt },
  );
  const expiredRaw = tokenFromEmail(expiredCap.sent[0]?.text ?? '');
  assert(Boolean(expiredRaw), 'expired-case email contains a token');
  if (expiredRaw) {
    const expired = await resetPasswordWithToken(
      { token: expiredRaw, password: 'NewPass123' },
      { now: new Date('2026-01-01T01:01:00.000Z') },
    );
    assert(expired.ok === false, 'expired token rejected');
  }

  const rateEmail = `pr-rate-${suffix}@example.com`;
  const rateUser = await prisma.user.create({
    data: {
      email: rateEmail,
      name: 'Reset Rate',
      passwordHash: await hashPassword('OldPass123'),
      role: 'MEMBER',
    },
  });
  userIds.push(rateUser.id);

  const rateCap = captureSender();
  const rateBodies: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const result = await requestPasswordReset(
      { email: rateEmail, ip: '10.0.0.5' },
      { send: rateCap.send },
    );
    rateBodies.push(JSON.stringify(result));
    assert(result.ok && result.message === GENERIC_FORGOT_MESSAGE, `rate-limit attempt ${i + 1} is generic success`);
  }
  assert(rateBodies.every((body) => body === rateBodies[0]), 'rate-limited responses stay identical');
  assert(rateCap.sent.length === 3, 'fourth request in an hour does not send another email');
} catch (error) {
  failed += 1;
  console.error('FAIL  password-reset service suite');
  console.error(error);
} finally {
  if (userIds.length) {
    await prisma.passwordResetToken.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
  }
  await prisma.$disconnect();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
