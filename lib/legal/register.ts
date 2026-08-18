import { Prisma } from '@/generated/prisma';
import { prisma } from '@/lib/db';
import { hashPassword, validateEmail } from '@/lib/password';
import { TERMS_REQUIRED_MESSAGE, TERMS_VERSION } from './terms';

const DUPLICATE_EMAIL = 'An account with this email already exists — log in instead';

export { TERMS_VERSION, TERMS_REQUIRED_MESSAGE };

export type RegisterInput = {
  name?: string;
  email?: string;
  password?: string;
  acceptTerms?: boolean;
};

export type RegisterResult =
  | { ok: true; user: { id: string; email: string; name: string; role: string } }
  | { ok: false; error: string; status: number; code?: string };

export async function registerAccount(input: RegisterInput): Promise<RegisterResult> {
  const name = String(input.name || '').trim();
  const email = String(input.email || '').trim().toLowerCase();
  const password = String(input.password || '');

  if (!input.acceptTerms) {
    return { ok: false, error: TERMS_REQUIRED_MESSAGE, status: 400 };
  }
  if (!name) {
    return { ok: false, error: 'Name is required', status: 400 };
  }
  if (!validateEmail(email)) {
    return { ok: false, error: 'Enter a valid email address', status: 400 };
  }
  if (password.length < 8) {
    return { ok: false, error: 'Password must be at least 8 characters', status: 400 };
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return { ok: false, error: DUPLICATE_EMAIL, status: 409, code: 'EMAIL_EXISTS' };
  }

  try {
    const user = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash: await hashPassword(password),
        role: 'MEMBER',
      },
      select: { id: true, email: true, name: true, role: true },
    });

    const acceptedAt = new Date();
    await prisma.$executeRaw`
      UPDATE "User"
      SET "termsAcceptedAt" = ${acceptedAt}, "termsVersion" = ${TERMS_VERSION}
      WHERE id = ${user.id}
    `;

    return { ok: true, user };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return { ok: false, error: DUPLICATE_EMAIL, status: 409, code: 'EMAIL_EXISTS' };
    }
    throw error;
  }
}

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
  const rows = await prisma.$queryRaw<Array<{ termsAcceptedAt: Date | null; termsVersion: string | null }>>`
    SELECT "termsAcceptedAt", "termsVersion" FROM "User" WHERE id = ${userId}
  `;
  const row = rows[0];
  return {
    termsAcceptedAt: row?.termsAcceptedAt ?? null,
    termsVersion: row?.termsVersion ?? null,
    currentVersion: TERMS_VERSION,
  };
}
