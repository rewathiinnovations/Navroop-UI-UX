'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, Settings, UserPlus } from 'lucide-react';
import { useAuth } from '@/components/app/auth/AuthProvider';
import { cn } from '@/utils/cn';

function workspaceInitial(name: string) {
  return name.trim().charAt(0).toUpperCase() || 'N';
}

export default function WorkspaceDropdown({
  teamName,
  memberCount,
}: {
  teamName: string;
  memberCount: number;
}) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const isAdmin = user?.role === 'ADMIN';

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

  return (
    <div className="relative px-10" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Open workspace menu"
        className={cn(
          'flex w-full min-h-[44px] items-center gap-8 rounded-10 px-8',
          'transition-colors duration-200 cursor-pointer',
          'hover:bg-[var(--studio-surface-hover)]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]',
        )}
      >
        <span className="flex size-28 shrink-0 items-center justify-center rounded-8 bg-[var(--studio-accent-soft)] text-[12px] font-semibold text-[var(--studio-accent-hover)]">
          {workspaceInitial(teamName)}
        </span>
        <span className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-[var(--studio-fg)]">
          {teamName}
        </span>
        <ChevronDown className="size-14 shrink-0 text-[var(--studio-faint)]" aria-hidden />
      </button>

      {open && (
        <div
          role="menu"
          className={cn(
            'absolute left-10 right-10 z-50 mt-4 overflow-hidden rounded-12',
            'border border-[var(--studio-line)] bg-[var(--studio-surface)]',
            'shadow-[0_12px_32px_rgba(24,24,27,0.12)]',
          )}
        >
          <div className="flex items-center gap-10 px-14 py-12 border-b border-[var(--studio-line)]">
            <span className="flex size-28 shrink-0 items-center justify-center rounded-8 bg-[var(--studio-accent-soft)] text-[12px] font-semibold text-[var(--studio-accent-hover)]">
              {workspaceInitial(teamName)}
            </span>
            <div className="min-w-0">
              <p className="truncate text-[13px] font-medium text-[var(--studio-fg)]">{teamName}</p>
              <p className="text-[12px] text-[var(--studio-muted)]">
                {memberCount} {memberCount === 1 ? 'member' : 'members'}
              </p>
            </div>
          </div>
          <div className="p-6">
            {isAdmin && (
              <Link
                href="/admin/team"
                role="menuitem"
                onClick={() => setOpen(false)}
                className="flex min-h-[44px] items-center gap-10 rounded-10 px-10 text-[14px] text-[var(--studio-fg)] hover:bg-[var(--studio-surface-hover)] transition-colors duration-200"
              >
                <UserPlus className="size-16 text-[var(--studio-muted)]" aria-hidden />
                Invite members
              </Link>
            )}
            <Link
              href="/settings/profile"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex min-h-[44px] items-center gap-10 rounded-10 px-10 text-[14px] text-[var(--studio-fg)] hover:bg-[var(--studio-surface-hover)] transition-colors duration-200"
            >
              <Settings className="size-16 text-[var(--studio-muted)]" aria-hidden />
              Settings
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
