'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { type ReactNode } from 'react';
import {
  Folder,
  Globe,
  LayoutDashboard,
  LayoutTemplate,
  PanelLeftClose,
  Plug,
  Search,
  Shield,
  Star,
  User,
  Users,
} from 'lucide-react';
import { cn } from '@/utils/cn';
import AccountMenu from './AccountMenu';
import CreditMeter from './CreditMeter';
import { useCommandPalette } from './CommandPalette';
import WorkspaceDropdown from './WorkspaceDropdown';

type RecentProject = { id: string; name: string; updatedLabel?: string };

function NavroopMark() {
  return (
    <Link
      href="/dashboard"
      aria-label="Navroop home"
      className="inline-flex size-36 items-center justify-center rounded-10 transition-opacity duration-200 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
    >
      <svg viewBox="0 0 32 32" className="size-28" fill="none" aria-hidden>
        <defs>
          <linearGradient
            id="navroopSidebarMark"
            x1="6"
            y1="2"
            x2="26"
            y2="30"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#FF8A3D" />
            <stop offset="0.48" stopColor="#FF5C7A" />
            <stop offset="1" stopColor="#C084FC" />
          </linearGradient>
        </defs>
        <path
          d="M16.2 27.4c-6.4-4.6-10.7-8.9-10.7-14.1C5.5 9.2 8.6 6.4 12.2 6.4c2.1 0 3.9.9 5 2.4 1.1-1.5 2.9-2.4 5-2.4 3.6 0 6.7 2.8 6.7 6.9 0 5.2-4.3 9.5-10.7 14.1-.6.4-1.4.4-2 0Z"
          fill="url(#navroopSidebarMark)"
        />
      </svg>
    </Link>
  );
}

function SidebarLink({
  href,
  icon,
  children,
  active,
}: {
  href: string;
  icon: ReactNode;
  children: ReactNode;
  active?: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'flex min-h-[44px] items-center gap-10 rounded-10 px-10 text-[13px] transition-colors duration-200',
        active
          ? 'bg-[var(--studio-surface-hover)] font-medium text-[var(--studio-fg)]'
          : 'text-[var(--studio-muted)] hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)]',
      )}
    >
      <span className="text-[var(--studio-faint)]">{icon}</span>
      {children}
    </Link>
  );
}

export default function Sidebar({
  teamName,
  memberCount,
  recents,
  isAdmin = false,
}: {
  teamName: string;
  memberCount: number;
  recents: RecentProject[];
  isAdmin?: boolean;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { openPalette } = useCommandPalette();

  const mine = searchParams.get('mine');
  const starred = searchParams.get('starred');
  const onDashboard = pathname === '/dashboard';
  const onProjects = pathname === '/projects';

  return (
    <aside className="relative z-20 flex h-full min-h-0 w-[272px] shrink-0 flex-col border-r border-[var(--studio-line)] bg-[var(--studio-header-bg)]">
      <div className="flex shrink-0 items-center justify-between px-12 pt-12">
        <NavroopMark />
        <button
          type="button"
          aria-label="Collapse sidebar"
          title="Collapse sidebar (coming soon)"
          className="inline-flex size-[44px] items-center justify-center rounded-10 text-[var(--studio-muted)] transition-colors duration-200 hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
        >
          <PanelLeftClose className="size-16" aria-hidden />
        </button>
      </div>

      <div className="mt-4 shrink-0">
        <WorkspaceDropdown teamName={teamName} memberCount={memberCount} />
      </div>

      <div className="mt-8 shrink-0 px-10">
        <label className="sr-only" htmlFor="sidebar-search">
          Search projects
        </label>
        <button
          type="button"
          id="sidebar-search"
          onClick={openPalette}
          className="flex h-40 w-full items-center gap-8 rounded-10 border border-[var(--studio-line)] bg-[var(--studio-surface)] px-10 text-left text-[13px] text-[var(--studio-faint)] hover:border-[var(--studio-line-strong)]"
        >
          <Search className="size-14 shrink-0" aria-hidden />
          Search projects
        </button>
      </div>

      <div className="studio-scroll mt-8 min-h-0 flex-1 pb-12">
        <nav className="flex flex-col gap-2 px-10" aria-label="Workspace">
          <SidebarLink
            href="/dashboard"
            icon={<LayoutDashboard className="size-16" />}
            active={onDashboard}
          >
            Dashboard
          </SidebarLink>
          <SidebarLink
            href="/templates"
            icon={<LayoutTemplate className="size-16" />}
            active={pathname === '/templates'}
          >
            Templates
          </SidebarLink>
          <SidebarLink
            href="/connectors"
            icon={<Plug className="size-16" />}
            active={pathname === '/connectors'}
          >
            Connectors
          </SidebarLink>
          <SidebarLink
            href="/deployments"
            icon={<Globe className="size-16" />}
            active={pathname === '/deployments'}
          >
            Deployments
          </SidebarLink>
          {/* Admin was previously reachable only from a menu item labelled "Team". */}
          {isAdmin && (
            <SidebarLink
              href="/admin"
              icon={<Shield className="size-16" />}
              active={pathname === '/admin' || pathname.startsWith('/admin/')}
            >
              Admin
            </SidebarLink>
          )}
        </nav>

        <div className="mt-16 px-10">
          <p className="mb-4 px-10 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--studio-faint)]">
            Projects
          </p>
          <div className="flex flex-col gap-2">
            <SidebarLink
              href="/projects"
              icon={<Folder className="size-16" />}
              active={onProjects && mine === null && starred !== 'true'}
            >
              All
            </SidebarLink>
            <SidebarLink
              href="/projects?starred=true"
              icon={<Star className="size-16" />}
              active={onProjects && starred === 'true'}
            >
              Starred
            </SidebarLink>
            <SidebarLink
              href="/projects?mine=true"
              icon={<User className="size-16" />}
              active={onProjects && mine === 'true'}
            >
              Owned by me
            </SidebarLink>
            <SidebarLink
              href="/projects?mine=false"
              icon={<Users className="size-16" />}
              active={onProjects && mine === 'false'}
            >
              Shared with me
            </SidebarLink>
          </div>
        </div>

        <div className="mt-16 px-10">
          <p className="mb-4 px-10 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--studio-faint)]">
            Recents
          </p>
          <div className="flex flex-col gap-2">
            {recents.length === 0 && (
              <p className="px-10 text-[12px] text-[var(--studio-faint)]">No recent projects</p>
            )}
            {recents.map((project) => (
              <Link
                key={project.id}
                href={`/project/${project.id}`}
                className="rounded-10 px-10 py-10 text-[13px] text-[var(--studio-muted)] transition-colors duration-200 hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)]"
              >
                <span className="block truncate">{project.name}</span>
                {project.updatedLabel && (
                  <span className="mt-2 block truncate text-[11px] text-[var(--studio-faint)]">
                    {project.updatedLabel}
                  </span>
                )}
              </Link>
            ))}
          </div>
        </div>
      </div>

      <div className="shrink-0 border-t border-[var(--studio-line)] p-10">
        <CreditMeter />
        <AccountMenu />
      </div>
    </aside>
  );
}
