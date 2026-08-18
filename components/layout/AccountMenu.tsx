'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { BookOpen, Box, Gauge, KeyRound, LayoutTemplate, ListTodo, LogOut, Monitor, Moon, Plug, Sparkles, Sun, UserRound, Users } from 'lucide-react';
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

export default function AccountMenu() {
  const router = useRouter();
  const { user, ready, setUser } = useAuth();
  const { theme, setTheme } = useTheme();
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

  if (!user) return null;

  const currentTheme = mounted ? theme : 'light';

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Open account menu"
        className={cn(
          'flex w-full min-h-[44px] items-center gap-10 rounded-10 px-8',
          'text-left transition-colors duration-200 cursor-pointer',
          'hover:bg-[var(--studio-surface-hover)]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]',
        )}
      >
        <span className="flex size-36 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[var(--studio-line)] bg-[var(--studio-accent-soft)] text-[13px] font-medium text-[var(--studio-accent-hover)]">
          {user.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={user.avatarUrl} alt="" className="size-36 rounded-full object-cover" />
          ) : (
            initials(user.name)
          )}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-medium text-[var(--studio-fg)]">{user.name}</span>
          <span className="block truncate text-[12px] text-[var(--studio-muted)]">{user.email}</span>
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className={cn(
            'studio-scroll absolute bottom-[calc(100%+8px)] left-0 right-0 z-50 max-h-[min(70dvh,520px)] rounded-12',
            'border border-[var(--studio-line)] bg-[var(--studio-surface)]',
            'shadow-[0_12px_32px_rgba(24,24,27,0.12)]',
          )}
        >
          <div className="flex items-center gap-12 px-16 py-14 border-b border-[var(--studio-line)]">
            <div className="flex size-36 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--studio-accent-soft)] text-[13px] font-medium text-[var(--studio-accent-hover)]">
              {user.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={user.avatarUrl} alt="" className="size-36 rounded-full object-cover" />
              ) : (
                initials(user.name)
              )}
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
            <MenuLink href="/settings/skills" icon={<Sparkles className="size-16" />} onClick={() => setOpen(false)}>
              Skills
            </MenuLink>
            <MenuLink href="/settings/usage" icon={<Gauge className="size-16" />} onClick={() => setOpen(false)}>
              Usage
            </MenuLink>
            {user.role === 'ADMIN' && (
              <>
                <MenuLink href="/admin/team" icon={<Users className="size-16" />} onClick={() => setOpen(false)}>
                  Team
                </MenuLink>
                <MenuLink href="/admin/jobs" icon={<ListTodo className="size-16" />} onClick={() => setOpen(false)}>
                  Jobs
                </MenuLink>
                <MenuLink href="/admin/integrations" icon={<Plug className="size-16" />} onClick={() => setOpen(false)}>
                  Integrations
                </MenuLink>
                <MenuLink href="/admin/templates" icon={<LayoutTemplate className="size-16" />} onClick={() => setOpen(false)}>
                  Templates
                </MenuLink>
                <MenuLink href="/admin/sandbox-providers" icon={<Box className="size-16" />} onClick={() => setOpen(false)}>
                  Sandbox providers
                </MenuLink>
              </>
            )}
          </div>

          <div className="px-16 py-10 border-t border-[var(--studio-line)]">
            <p className="mb-8 text-[12px] font-medium uppercase tracking-[0.08em] text-[var(--studio-faint)]">
              Appearance
            </p>
            <div className="grid grid-cols-3 rounded-10 bg-[var(--studio-skeleton)] p-4">
              <ThemeChoice
                label="Light"
                icon={<Sun className="size-14" />}
                pressed={currentTheme === 'light'}
                onClick={() => setTheme('light')}
              />
              <ThemeChoice
                label="Dark"
                icon={<Moon className="size-14" />}
                pressed={currentTheme === 'dark'}
                onClick={() => setTheme('dark')}
              />
              <ThemeChoice
                label="System"
                icon={<Monitor className="size-14" />}
                pressed={currentTheme === 'system'}
                onClick={() => setTheme('system')}
              />
            </div>
          </div>

          <div className="p-6 border-t border-[var(--studio-line)]">
            <MenuLink href="#" icon={<BookOpen className="size-16" />} onClick={() => setOpen(false)}>
              Documentation
            </MenuLink>
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

function ThemeChoice({
  label,
  icon,
  pressed,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      className={cn(
        'inline-flex min-h-[44px] flex-col items-center justify-center gap-2 rounded-8 text-[11px] cursor-pointer transition-colors duration-200',
        pressed
          ? 'bg-[var(--studio-surface)] text-[var(--studio-fg)] shadow-sm'
          : 'text-[var(--studio-muted)] hover:text-[var(--studio-fg)]',
      )}
    >
      {icon}
      {label}
    </button>
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
