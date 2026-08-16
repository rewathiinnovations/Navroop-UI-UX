'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { KeyRound, LogOut, Moon, Sun, UserRound, Users } from 'lucide-react';
import { signOut } from 'next-auth/react';
import { useAuth } from '@/components/app/auth/AuthProvider';
import { cn } from '@/utils/cn';

function initials(name: string) {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || 'N';
}

export default function UserMenu({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const { user, ready, setUser } = useAuth();
  const { resolvedTheme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const logout = async () => {
    await signOut({ redirect: false });
    setUser(null);
    setOpen(false);
    router.push('/');
    router.refresh();
  };

  if (!ready) {
    return <div className="size-36 rounded-full bg-[var(--studio-skeleton)] animate-pulse" />;
  }

  if (!user) {
    return (
      <Link
        href="/?auth=login"
        className="inline-flex min-h-[44px] items-center px-14 text-[14px] text-[var(--studio-muted)] hover:text-[var(--studio-fg)] transition-colors duration-200"
      >
        Sign in
      </Link>
    );
  }

  const isDark = mounted && resolvedTheme === 'dark';

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Open user menu"
        className={cn(
          'inline-flex size-36 items-center justify-center rounded-full',
          'bg-[var(--studio-accent-soft)] text-[13px] font-medium text-[var(--studio-accent-hover)]',
          'border border-[var(--studio-line)]',
          'transition-colors duration-200 cursor-pointer',
          'hover:border-[var(--studio-line-strong)]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]',
        )}
      >
        {user.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={user.avatarUrl} alt="" className="size-36 rounded-full object-cover" />
        ) : (
          initials(user.name)
        )}
      </button>

      {open && (
        <div
          role="menu"
          className={cn(
            'absolute right-0 z-50 mt-8 w-[280px] overflow-hidden rounded-12',
            'border border-[var(--studio-line)] bg-[var(--studio-surface)]',
            'shadow-[0_12px_32px_rgba(24,24,27,0.12)]',
            compact && 'w-[260px]',
          )}
        >
          <div className="flex items-center gap-12 px-16 py-14 border-b border-[var(--studio-line)]">
            <div className="flex size-36 shrink-0 items-center justify-center rounded-full bg-[var(--studio-accent-soft)] text-[13px] font-medium text-[var(--studio-accent-hover)]">
              {initials(user.name)}
            </div>
            <div className="min-w-0">
              <p className="truncate text-[14px] font-medium text-[var(--studio-fg)]">{user.name}</p>
              <p className="truncate text-[12px] text-[var(--studio-muted)]">{user.email}</p>
            </div>
          </div>

          <div className="p-6">
            <MenuLink href="/settings/profile" icon={<UserRound className="size-16" />} onClick={() => setOpen(false)}>
              Profile
            </MenuLink>
            <MenuLink href="/settings/api-keys" icon={<KeyRound className="size-16" />} onClick={() => setOpen(false)}>
              API Keys
            </MenuLink>
            {user.role === 'ADMIN' && (
              <MenuLink href="/admin/team" icon={<Users className="size-16" />} onClick={() => setOpen(false)}>
                Team
              </MenuLink>
            )}
          </div>

          <div className="px-16 py-10 border-t border-[var(--studio-line)]">
            <p className="mb-8 text-[12px] font-medium uppercase tracking-[0.08em] text-[var(--studio-faint)]">
              Appearance
            </p>
            <div className="grid grid-cols-2 rounded-10 bg-[var(--studio-skeleton)] p-4">
              <button
                type="button"
                onClick={() => setTheme('light')}
                aria-pressed={!isDark}
                className={cn(
                  'inline-flex min-h-[44px] items-center justify-center gap-6 rounded-8 text-[13px] cursor-pointer transition-colors duration-200',
                  !isDark
                    ? 'bg-[var(--studio-surface)] text-[var(--studio-fg)] shadow-sm'
                    : 'text-[var(--studio-muted)] hover:text-[var(--studio-fg)]',
                )}
              >
                <Sun className="size-14" aria-hidden />
                Light
              </button>
              <button
                type="button"
                onClick={() => setTheme('dark')}
                aria-pressed={isDark}
                className={cn(
                  'inline-flex min-h-[44px] items-center justify-center gap-6 rounded-8 text-[13px] cursor-pointer transition-colors duration-200',
                  isDark
                    ? 'bg-[var(--studio-surface)] text-[var(--studio-fg)] shadow-sm'
                    : 'text-[var(--studio-muted)] hover:text-[var(--studio-fg)]',
                )}
              >
                <Moon className="size-14" aria-hidden />
                Dark
              </button>
            </div>
          </div>

          <div className="p-6 border-t border-[var(--studio-line)]">
            <button
              type="button"
              role="menuitem"
              onClick={logout}
              className="flex w-full min-h-[44px] items-center gap-10 rounded-10 px-10 text-[14px] text-[var(--studio-danger)] hover:bg-[var(--studio-accent-soft)] transition-colors duration-200 cursor-pointer"
            >
              <LogOut className="size-16" aria-hidden />
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MenuLink({
  href,
  icon,
  children,
  onClick,
}: {
  href: string;
  icon: ReactNode;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <Link
      href={href}
      role="menuitem"
      onClick={onClick}
      className="flex min-h-[44px] items-center gap-10 rounded-10 px-10 text-[14px] text-[var(--studio-fg)] hover:bg-[var(--studio-surface-hover)] transition-colors duration-200"
    >
      <span className="text-[var(--studio-muted)]">{icon}</span>
      {children}
    </Link>
  );
}
