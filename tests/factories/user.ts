import { hashPassword } from '../../lib/password';
import { uniqueSuffix } from './ids';

export type UserFactoryDb = {
  user: {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string; email: string; role: string; isActive: boolean }>;
  };
};

export async function createUser(
  db: UserFactoryDb,
  overrides: {
    email?: string;
    name?: string;
    role?: 'ADMIN' | 'MEMBER';
    isActive?: boolean;
    password?: string;
  } = {},
) {
  const suffix = uniqueSuffix();
  return db.user.create({
    data: {
      email: overrides.email ?? `user-${suffix}@example.com`,
      name: overrides.name ?? 'Test User',
      passwordHash: await hashPassword(overrides.password ?? 'ChangeMeNow123'),
      role: overrides.role ?? 'MEMBER',
      isActive: overrides.isActive ?? true,
    },
  });
}
