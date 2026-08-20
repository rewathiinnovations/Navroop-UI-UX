'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import {
  Folder,
  Globe,
  LayoutDashboard,
  LayoutTemplate,
  PanelLeftClose,
  PanelLeftOpen,
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

const COLLAPSE_KEY = 'navroop.sidebar.collapsed';

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
            <stop offset="0.55" stopColor="#FA4500" />
            <stop offset="1" stopColor="#D63B00" />
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
  collapsed,
}: {
  href: string;
  icon: ReactNode;
  children: ReactNode;
  active?: boolean;
  /** Icon-only, centered, with the label moved to a hover title instead of inline text. */
  collapsed?: boolean;
}) {
  return (
    <Link
      href={href}
      title={collapsed ? String(children) : undefined}
      className={cn(
        'flex min-h-[44px] items-center gap-10 rounded-10 text-[13px] transition-colors duration-200',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]',
        collapsed ? 'justify-center px-0' : 'px-10',
        active
          ? 'bg-[var(--studio-surface-hover)] font-medium text-[var(--studio-fg)]'
          : 'text-[var(--studio-muted)] hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)]',
      )}
    >
      <span className="text-[var(--studio-faint)]">{icon}</span>
      {!collapsed && children}
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
  const [collapsed, setCollapsed] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const apply = () => setIsMobile(media.matches);
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, []);

  const railCollapsed = collapsed && !isMobile;

  // Read the saved choice after mount only, so the server-rendered (always
  // expanded) markup matches the client's first render and React never sees
  // a hydration mismatch; a collapsed user sees one frame of the full
  // sidebar before this effect narrows it.
  useEffect(() => {
    try {
      if (window.localStorage.getItem(COLLAPSE_KEY) === '1') setCollapsed(true);
    } catch {
      // Storage can throw in locked-down environments (private mode, disabled cookies) — collapse stays off.
    }
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        // Non-fatal — the toggle still works for this session, it just won't persist.
      }
      return next;
    });
  };

  const mine = searchParams.get('mine');
  const starred = searchParams.get('starred');
  const onDashboard = pathname === '/dashboard';
  const onProjects = pathname === '/projects';

  return (
    <aside
      className={cn(
        'relative z-20 flex h-full min-h-0 shrink-0 flex-col border-r border-[var(--studio-line)] bg-[var(--studio-header-bg)] transition-[width] duration-200',
        railCollapsed ? 'w-[68px]' : 'w-[272px]',
      )}
    >
      <div
        className={cn(
          'flex shrink-0 items-center pt-12',
          railCollapsed ? 'flex-col gap-8 px-12' : 'justify-between px-12',
        )}
      >
        <NavroopMark />
        <button
          type="button"
          aria-label={railCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={railCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={toggleCollapsed}
          className="hidden size-[44px] shrink-0 items-center justify-center rounded-10 text-[var(--studio-muted)] transition-colors duration-200 hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)] md:inline-flex"
        >
          {railCollapsed ? (
            <PanelLeftOpen className="size-16" aria-hidden />
          ) : (
            <PanelLeftClose className="size-16" aria-hidden />
          )}
        </button>
      </div>

      {!railCollapsed && (
        <div className="mt-4 shrink-0">
          <WorkspaceDropdown teamName={teamName} memberCount={memberCount} />
        </div>
      )}

      {!railCollapsed && (
        <div className="mt-8 shrink-0 px-10">
          <label className="sr-only" htmlFor="sidebar-search">
            Search projects
          </label>
          <button
            type="button"
            id="sidebar-search"
            onClick={openPalette}
            className="flex h-44 w-full items-center gap-8 rounded-10 border border-[var(--studio-line)] bg-[var(--studio-surface)] px-10 text-left text-[13px] text-[var(--studio-faint)] hover:border-[var(--studio-line-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
          >
            <Search className="size-14 shrink-0" aria-hidden />
            Search projects
          </button>
        </div>
      )}
      {railCollapsed && (
        <div className="mt-8 shrink-0 px-12">
          <button
            type="button"
            aria-label="Search projects"
            title="Search projects"
            onClick={openPalette}
            className="flex h-40 w-full items-center justify-center rounded-10 border border-[var(--studio-line)] bg-[var(--studio-surface)] text-[var(--studio-faint)] hover:border-[var(--studio-line-strong)]"
          >
            <Search className="size-14 shrink-0" aria-hidden />
          </button>
        </div>
      )}

      <div className="studio-scroll mt-8 min-h-0 flex-1 pb-12">
        <nav
          className={cn('flex flex-col gap-2', railCollapsed ? 'px-12' : 'px-10')}
          aria-label="Workspace"
        >
          <SidebarLink
            href="/dashboard"
            icon={<LayoutDashboard className="size-16" />}
            active={onDashboard}
            collapsed={railCollapsed}
          >
            Dashboard
          </SidebarLink>
          <SidebarLink
            href="/templates"
            icon={<LayoutTemplate className="size-16" />}
            active={pathname === '/templates'}
            collapsed={railCollapsed}
          >
            Templates
          </SidebarLink>
          <SidebarLink
            href="/connectors"
            icon={<Plug className="size-16" />}
            active={pathname === '/connectors'}
            collapsed={railCollapsed}
          >
            Connectors
          </SidebarLink>
          <SidebarLink
            href="/deployments"
            icon={<Globe className="size-16" />}
            active={pathname === '/deployments'}
            collapsed={railCollapsed}
          >
            Deployments
          </SidebarLink>
          {/* Admin was previously reachable only from a menu item labelled "Team". */}
          {isAdmin && (
            <SidebarLink
              href="/admin"
              icon={<Shield className="size-16" />}
              active={pathname === '/admin' || pathname.startsWith('/admin/')}
              collapsed={railCollapsed}
            >
              Admin
            </SidebarLink>
          )}
        </nav>

        {!railCollapsed && (
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
        )}

        {!railCollapsed && (
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
                  className="rounded-10 px-10 py-10 text-[13px] text-[var(--studio-muted)] transition-colors duration-200 hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
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
        )}
      </div>

      <div className="shrink-0 border-t border-[var(--studio-line)] p-10">
        {!railCollapsed && <CreditMeter />}
        {railCollapsed ? (
          <button
            type="button"
            aria-label="Expand sidebar to open account menu"
            title="Expand sidebar to open account menu"
            onClick={toggleCollapsed}
            className="mx-auto flex size-36 items-center justify-center overflow-hidden rounded-full border border-[var(--studio-line)] bg-[var(--studio-accent-soft)] text-[13px] font-medium text-[var(--studio-accent-hover)] transition-colors duration-200 hover:border-[var(--studio-line-strong)]"
          >
            <User className="size-15" aria-hidden />
          </button>
        ) : (
          <AccountMenu />
        )}
      </div>
    </aside>
  );
}
