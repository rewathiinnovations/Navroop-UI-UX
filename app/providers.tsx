'use client';

import { SessionProvider } from 'next-auth/react';
import { ThemeProvider } from 'next-themes';
import { AuthProvider } from '@/components/app/auth/AuthProvider';
import { GenerationProvider } from '@/components/app/generation/GenerationProvider';
import { CommandPaletteProvider } from '@/components/layout/CommandPalette';

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
        <AuthProvider>
          <GenerationProvider>
            <CommandPaletteProvider>
              {children}
            </CommandPaletteProvider>
          </GenerationProvider>
        </AuthProvider>
      </ThemeProvider>
    </SessionProvider>
  );
}
