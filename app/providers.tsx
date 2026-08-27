'use client';

import { SessionProvider } from 'next-auth/react';
import { ThemeProvider } from 'next-themes';
import { AuthProvider } from '@/components/app/auth/AuthProvider';
import { GenerationProvider } from '@/components/app/generation/GenerationProvider';
import { CommandPaletteProvider } from '@/components/layout/CommandPalette';
import OfflineBanner from '@/components/layout/OfflineBanner';
import { Toaster } from '@/components/ui/Toaster';

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    /*
     * Explicit refetch policy. With no props NextAuth defaults
     * `refetchOnWindowFocus` to true, so every focus/visibility change is a full
     * GET /api/auth/session — measured at twelve of them in a 34-second window on
     * an idle workspace, each one re-running the Auth.js callbacks and re-reading
     * the user row from Postgres.
     *
     * Lengthening this does not widen the window in which a revoked session keeps
     * working, because nothing is authorised from this cached copy. Revocation is
     * enforced per request on the server: `getSessionUser` (lib/auth.ts) re-reads
     * `isActive` before any route answers, and the `jwt` callback in auth.ts
     * re-reads `isActive` and `passwordChangedAt` on every `auth()` and deletes
     * the token id when either says the session is gone. A deactivated user
     * holding a stale session object gets a 401 from the first request they make;
     * the interval only decides how long stale chrome — name, avatar, role badge —
     * stays on screen, which is why fifteen minutes is generous rather than risky.
     * Sign-in and sign-out in another tab still arrive immediately: NextAuth's
     * BroadcastChannel listener is not gated by either prop.
     */
    <SessionProvider
      refetchOnWindowFocus={false}
      refetchInterval={15 * 60}
      refetchWhenOffline={false}
    >
      <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
        <AuthProvider>
          <GenerationProvider>
            <CommandPaletteProvider>
              {children}
              <Toaster />
              <OfflineBanner />
            </CommandPaletteProvider>
          </GenerationProvider>
        </AuthProvider>
      </ThemeProvider>
    </SessionProvider>
  );
}
