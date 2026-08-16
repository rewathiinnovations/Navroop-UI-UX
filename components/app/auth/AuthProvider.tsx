'use client';

import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { signOut, useSession } from 'next-auth/react';

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  role: 'ADMIN' | 'MEMBER';
  avatarUrl: string | null;
};

type AuthContextValue = {
  user: AuthUser | null;
  ready: boolean;
  refresh: () => Promise<void>;
  setUser: (user: AuthUser | null) => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function fromSession(user: {
  id?: string;
  email?: string | null;
  name?: string | null;
  role?: 'ADMIN' | 'MEMBER';
  avatarUrl?: string | null;
  image?: string | null;
} | undefined): AuthUser | null {
  if (!user?.id || !user.email) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name || user.email,
    role: user.role ?? 'MEMBER',
    avatarUrl: user.avatarUrl ?? user.image ?? null,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { data: session, status, update } = useSession();
  const user = fromSession(session?.user);
  const ready = status !== 'loading';

  const refresh = useCallback(async () => {
    await update();
  }, [update]);

  const setUser = useCallback((next: AuthUser | null) => {
    if (next === null) {
      void signOut({ redirect: false });
    }
  }, []);

  const value = useMemo(
    () => ({ user, ready, refresh, setUser }),
    [user, ready, refresh, setUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
