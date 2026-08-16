import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import type { Role } from '@/generated/prisma';

export { auth, signIn, signOut } from '@/auth';
export { hashPassword, validateEmail, verifyPassword, getSeedAdminCredentials } from '@/lib/password';

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  avatarUrl: string | null;
};

export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) return null;

  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, name: true, role: true, avatarUrl: true },
  });
  return user;
}

export async function requireSessionUser() {
  const user = await getSessionUser();
  if (!user) {
    return { user: null as SessionUser | null, error: 'Sign in required' as const, status: 401 as const };
  }
  return { user, error: null, status: 200 as const };
}

export async function requireAdmin() {
  const result = await requireSessionUser();
  if (!result.user) return result;
  if (result.user.role !== 'ADMIN') {
    return { user: null as SessionUser | null, error: 'Admin access required' as const, status: 403 as const };
  }
  return result;
}

export function toPublicUser(user: SessionUser) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    avatarUrl: user.avatarUrl,
  };
}
