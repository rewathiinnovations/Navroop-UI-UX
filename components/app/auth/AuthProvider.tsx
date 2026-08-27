'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
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
  /**
   * Ends the session. This owns the `signOut` call: the old `setUser(next)` did
   * nothing at all for a non-null argument and issued a second, unawaited
   * `signOut` for `null`, which every caller had already made itself.
   */
  signOutUser: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function fromSession(
  user:
    | {
        id?: string;
        email?: string | null;
        name?: string | null;
        role?: 'ADMIN' | 'MEMBER';
        avatarUrl?: string | null;
        image?: string | null;
      }
    | undefined,
): AuthUser | null {
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
  const ready = status !== 'loading';

  /**
   * Memoised on the fields, never on `session.user`.
   *
   * Every session refetch calls `setSession` with a freshly parsed object, so
   * the object identity changes even when the user did not — and NextAuth's own
   * context value is `useMemo(…, [session, loading])`, which hands `update` a
   * new identity on the same tick. `fromSession(session?.user)` built a new
   * `AuthUser` on every one of those renders, the memo below listed it as a
   * dependency, and the context value therefore changed identity on every
   * render. That re-rendered every `useAuth()` consumer in the tree on a poll
   * that had told us nothing new. The scalars below are what `fromSession`
   * actually reads, so an unchanged session now produces the identical object.
   */
  const sessionUser = session?.user;
  const userId = sessionUser?.id;
  const userEmail = sessionUser?.email ?? null;
  const userName = sessionUser?.name ?? null;
  const userRole = sessionUser?.role;
  const userAvatarUrl = sessionUser?.avatarUrl ?? sessionUser?.image ?? null;

  const user = useMemo(
    () =>
      fromSession({
        id: userId,
        email: userEmail,
        name: userName,
        role: userRole,
        avatarUrl: userAvatarUrl,
      }),
    [userId, userEmail, userName, userRole, userAvatarUrl],
  );

  /**
   * `update` is re-created by NextAuth on every session change, so keying
   * `refresh` on it put the same churn back into the context value that
   * memoising `user` had just taken out. The ref is written in an effect, never
   * during render.
   */
  const updateRef = useRef(update);
  useEffect(() => {
    updateRef.current = update;
  }, [update]);

  const refresh = useCallback(async () => {
    await updateRef.current();
  }, []);

  const signOutUser = useCallback(async () => {
    await signOut({ redirect: false });
  }, []);

  const value = useMemo(
    () => ({ user, ready, refresh, signOutUser }),
    [user, ready, refresh, signOutUser],
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
