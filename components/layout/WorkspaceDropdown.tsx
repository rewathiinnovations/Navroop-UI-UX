'use client';

import Link from 'next/link';
import { ChevronDown, Settings, UserPlus } from 'lucide-react';
import { useAuth } from '@/components/app/auth/AuthProvider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/shadcn/dropdown-menu';
import { cn } from '@/utils/cn';

function workspaceInitial(name: string) {
  return name.trim().charAt(0).toUpperCase() || 'N';
}

const itemClass =
  'flex min-h-[44px] cursor-pointer items-center gap-10 rounded-10 px-10 text-[14px] text-[var(--studio-fg)] focus:bg-[var(--studio-surface-hover)] focus:text-[var(--studio-fg)]';

/**
 * A real menu — a header label plus one or two commands — so it runs on the
 * Radix `DropdownMenu` rather than a hand-rolled `role="menu"` div. The
 * hand-rolled version declared the role while implementing none of the menu
 * keyboard contract: opening did not move focus, arrows and Home/End did
 * nothing, and there was no roving tabIndex.
 */
export default function WorkspaceDropdown({
  teamName,
  memberCount,
}: {
  teamName: string;
  memberCount: number;
}) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';

  return (
    <div className="px-10">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
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
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className="studio-portal z-50 w-[var(--radix-dropdown-menu-trigger-width)] min-w-[220px] rounded-12 border-[var(--studio-line)] bg-[var(--studio-surface)] p-0 text-[var(--studio-fg)] shadow-[0_12px_32px_rgba(24,24,27,0.12)]"
        >
          <DropdownMenuLabel className="flex items-center gap-10 px-14 py-12 font-normal">
            <span className="flex size-28 shrink-0 items-center justify-center rounded-8 bg-[var(--studio-accent-soft)] text-[12px] font-semibold text-[var(--studio-accent-hover)]">
              {workspaceInitial(teamName)}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-medium text-[var(--studio-fg)]">
                {teamName}
              </span>
              <span className="block text-[12px] text-[var(--studio-muted)]">
                {memberCount} {memberCount === 1 ? 'member' : 'members'}
              </span>
            </span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator className="bg-[var(--studio-line)]" />
          <div className="p-6">
            {isAdmin && (
              <DropdownMenuItem asChild className={itemClass}>
                <Link href="/admin/team">
                  <UserPlus className="size-16 text-[var(--studio-muted)]" aria-hidden />
                  Invite members
                </Link>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem asChild className={itemClass}>
              <Link href="/settings/profile">
                <Settings className="size-16 text-[var(--studio-muted)]" aria-hidden />
                Settings
              </Link>
            </DropdownMenuItem>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
