import type { DefaultSession } from 'next-auth';
import type { Role } from '@/generated/prisma';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      role: Role;
      isActive: boolean;
      avatarUrl: string | null;
    } & DefaultSession['user'];
  }

  interface User {
    role: Role;
    isActive?: boolean;
    avatarUrl?: string | null;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id?: string;
    role?: Role;
    isActive?: boolean;
    avatarUrl?: string | null;
  }
}

declare module '@auth/core/jwt' {
  interface JWT {
    id?: string;
    role?: Role;
    isActive?: boolean;
    avatarUrl?: string | null;
  }
}
