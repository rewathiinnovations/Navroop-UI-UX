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
    select: { id: true, email: true, name: true, role: true, avatarUrl: true, isActive: true },
  });
  if (!user || !user.isActive) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    avatarUrl: user.avatarUrl,
  };
}

export async function requireSessionUser(): Promise<
  | { user: SessionUser; error: null; status: 200 }
  | { user: null; error: 'Sign in required'; status: 401 }
> {
  const user = await getSessionUser();
  if (!user) {
    return { user: null, error: 'Sign in required', status: 401 };
  }
  return { user, error: null, status: 200 };
}

export async function requireAdmin(): Promise<
  | { user: SessionUser; error: null; status: 200 }
  | { user: null; error: 'Sign in required' | 'Admin access required'; status: 401 | 403 }
> {
  const result = await requireSessionUser();
  if (!result.user) return result;
  if (result.user.role !== 'ADMIN') {
    return { user: null, error: 'Admin access required', status: 403 };
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
