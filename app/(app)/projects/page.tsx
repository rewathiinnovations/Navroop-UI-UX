'use client';

import Link from 'next/link';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { LayoutGrid, List, Plus } from 'lucide-react';
import StudioButton from '@/components/app/studio/StudioButton';
import StudioShell from '@/components/app/studio/StudioShell';
import ProjectCard from '@/components/dashboard/ProjectCard';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/shadcn/dropdown-menu';
import { listAnnouncement } from '@/lib/a11y/list-announcement';
import { connectionState } from '@/lib/net/connection';
import { useRefetchOnReconnect } from '@/hooks/useOnline';
import {
  bucketProjectsByUpdatedAt,
  fetchProjectList,
  isProjectGenerating,
  type ListProject,
} from '@/lib/projects/list-client';
import { cn } from '@/utils/cn';
import {
  OWNER_FILTER_LABELS,
  mineFromOwnerFilter,
  ownerFilterFor,
  parseMine,
  type OwnerFilter,
} from './owner-filter';

type SortKey = 'updatedAt' | 'name' | 'createdAt';
type StatusFilter = 'any' | 'draft' | 'published';
type Density = 'grid' | 'list';

function parseSort(value: string | null): SortKey {
  if (value === 'name' || value === 'createdAt' || value === 'updatedAt') return value;
  return 'updatedAt';
}

function parseStatus(value: string | null): StatusFilter {
  if (value === 'draft' || value === 'published') return value;
  return 'any';
}

function ProjectsContent() {
  const searchParams = useSearchParams();
  const [search, setSearch] = useState(searchParams.get('search') ?? '');
  const [sort, setSort] = useState<SortKey>(parseSort(searchParams.get('sort')));
  const [status, setStatus] = useState<StatusFilter>(parseStatus(searchParams.get('status')));
  const [mine, setMine] = useState<boolean | undefined>(parseMine(searchParams.get('mine')));
  const starred = searchParams.get('starred') === 'true';
  const [density, setDensity] = useState<Density>('grid');
  const [projects, setProjects] = useState<ListProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setSearch(searchParams.get('search') ?? '');
    setSort(parseSort(searchParams.get('sort')));
    setStatus(parseStatus(searchParams.get('status')));
    setMine(parseMine(searchParams.get('mine')));
  }, [searchParams]);

  const persistUrl = useCallback(
    (patch: {
      search?: string;
      sort?: SortKey;
      status?: StatusFilter;
      mine?: boolean | undefined;
    }) => {
      const params = new URLSearchParams();
      const nextSearch = (patch.search !== undefined ? patch.search : search).trim();
      const nextSort = patch.sort !== undefined ? patch.sort : sort;
      const nextStatus = patch.status !== undefined ? patch.status : status;
      const nextMine = 'mine' in patch ? patch.mine : mine;
      if (nextSearch) params.set('search', nextSearch);
      if (nextSort !== 'updatedAt') params.set('sort', nextSort);
      if (nextStatus !== 'any') params.set('status', nextStatus);
      if (nextMine === true) params.set('mine', 'true');
      if (nextMine === false) params.set('mine', 'false');
      if (starred) params.set('starred', 'true');
      const qs = params.toString();
      window.history.replaceState(null, '', qs ? `/projects?${qs}` : '/projects');
    },
    [mine, search, sort, starred, status],
  );

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      // One path, search or not. Typing in the box used to switch to `/api/search`, whose
      // payload carries no thumbnail, no owner and no star state — so every card lost its
      // screenshot and read as owned by "Member" — and which takes neither `mine` nor
      // `starred`, so picking "Owned by me" or "Starred" silently stopped applying and the
      // results were the whole workspace. `/api/projects` filters by name and prompt
      // server-side and returns the same rows the unsearched list does.
      const result = await fetchProjectList({
        search: search.trim() || undefined,
        sort,
        mine,
        starred: starred || undefined,
      });
      if (!result.ok) {
        setError(result.error);
        if (!silent) setLoading(false);
        return;
      }
      setProjects(result.projects);
      setError('');
      if (!silent) setLoading(false);
    },
    [mine, search, sort, starred],
  );

  useEffect(() => {
    const timer = window.setTimeout(
      () => {
        void load();
      },
      search ? 250 : 0,
    );
    return () => window.clearTimeout(timer);
  }, [load, search]);

  useEffect(() => {
    if (!projects.some(isProjectGenerating)) return;
    const timer = setInterval(() => {
      // Offline: nothing to gain from another failed request. `load` already
      // renders the offline sentence, and the reconnect refetch below is the one
      // catch-up (F-446).
      if (connectionState() === 'offline') return;
      void load(true);
    }, 4000);
    return () => clearInterval(timer);
  }, [load, projects]);

  useRefetchOnReconnect(useCallback(() => void load(true), [load]));

  const filtered = useMemo(() => {
    if (status === 'any') return projects;
    return projects.filter((project) => project.status === status);
  }, [projects, status]);

  const buckets = useMemo(() => bucketProjectsByUpdatedAt(filtered), [filtered]);

  const onRenamed = (id: string, name: string) => {
    setProjects((current) =>
      current.map((project) => (project.id === id ? { ...project, name } : project)),
    );
  };

  const onDuplicated = (project: ListProject) => {
    setProjects((current) => [project, ...current]);
  };

  const onDeleted = (id: string) => {
    setProjects((current) => current.filter((project) => project.id !== id));
  };

  // On `?starred=true` the row no longer belongs in the list it is sitting in, so drop it
  // rather than leave a card the filter would not have returned.
  const onStarred = (id: string, isStarred: boolean) => {
    setProjects((current) =>
      starred && !isStarred
        ? current.filter((project) => project.id !== id)
        : current.map((project) =>
            project.id === id ? { ...project, starred: isStarred } : project,
          ),
    );
  };

  const selectClass =
    'h-44 rounded-10 border border-[var(--studio-line)] bg-[var(--studio-surface)] px-12 text-[14px] text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]';

  return (
    <StudioShell variant="workspace">
      <main className="mx-auto max-w-[1100px] px-20 pb-64 pt-40">
        <div className="mb-24 flex flex-wrap items-center justify-between gap-12">
          <h1 className="text-[32px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">
            Projects
          </h1>
          {/* A real menu of create actions: Radix supplies the aria-haspopup /
              aria-expanded on the trigger, arrow-key roving focus, Escape and
              focus restore that the hand-rolled `role="menu"` div promised and
              never implemented (its only dismissal was a document click). */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <StudioButton variant="primary">
                <Plus className="size-16" aria-hidden />
                Create
              </StudioButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              sideOffset={8}
              collisionPadding={8}
              className="studio-portal z-50 w-200 rounded-10 border-[var(--studio-line)] bg-[var(--studio-surface)] p-0 text-[var(--studio-fg)] shadow-[0_12px_24px_rgba(24,24,27,0.12)]"
            >
              <DropdownMenuItem
                asChild
                className="min-h-[44px] cursor-pointer rounded-10 px-14 text-[14px] text-[var(--studio-fg)] focus:bg-[var(--studio-surface-hover)] focus:text-[var(--studio-fg)]"
              >
                <Link href="/dashboard?focus=prompt">Blank project</Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="mb-28 flex flex-col gap-12 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-8">
            <label className="sr-only" htmlFor="project-search">
              Search projects
            </label>
            <input
              id="project-search"
              value={search}
              onChange={(event) => {
                const value = event.target.value;
                setSearch(value);
                persistUrl({ search: value });
              }}
              placeholder="Search"
              className="h-44 w-full max-w-[280px] rounded-10 border border-[var(--studio-line)] bg-[var(--studio-surface)] px-12 text-[14px] text-[var(--studio-fg)] placeholder:text-[var(--studio-faint)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
            />
            <label className="flex items-center gap-8 text-[13px] text-[var(--studio-muted)]">
              Sort
              <select
                value={sort}
                onChange={(event) => {
                  const value = event.target.value as SortKey;
                  setSort(value);
                  persistUrl({ sort: value });
                }}
                className={selectClass}
              >
                <option value="updatedAt">Last edited</option>
                <option value="name">Name</option>
                <option value="createdAt">Created</option>
              </select>
            </label>
            <label className="flex items-center gap-8 text-[13px] text-[var(--studio-muted)]">
              Status
              <select
                value={status}
                onChange={(event) => {
                  const value = event.target.value as StatusFilter;
                  setStatus(value);
                  persistUrl({ status: value });
                }}
                className={selectClass}
              >
                <option value="any">Any</option>
                <option value="draft">Draft</option>
                <option value="published">Published</option>
              </select>
            </label>
            <label className="flex items-center gap-8 text-[13px] text-[var(--studio-muted)]">
              Owner
              <select
                value={ownerFilterFor(mine)}
                onChange={(event) => {
                  const next = mineFromOwnerFilter(event.target.value);
                  setMine(next);
                  persistUrl({ mine: next });
                }}
                className={selectClass}
              >
                {(['all', 'mine', 'shared'] as OwnerFilter[]).map((option) => (
                  <option key={option} value={option}>
                    {OWNER_FILTER_LABELS[option]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div
            className="inline-flex rounded-10 border border-[var(--studio-line)] p-4"
            role="group"
            aria-label="Layout"
          >
            <button
              type="button"
              aria-pressed={density === 'grid'}
              aria-label="Grid view"
              onClick={() => setDensity('grid')}
              className={cn(
                'inline-flex size-[36px] items-center justify-center rounded-8 transition-colors duration-200',
                density === 'grid'
                  ? 'bg-[var(--studio-surface-hover)] text-[var(--studio-fg)]'
                  : 'text-[var(--studio-muted)] hover:text-[var(--studio-fg)]',
              )}
            >
              <LayoutGrid className="size-16" aria-hidden />
            </button>
            <button
              type="button"
              aria-pressed={density === 'list'}
              aria-label="List view"
              onClick={() => setDensity('list')}
              className={cn(
                'inline-flex size-[36px] items-center justify-center rounded-8 transition-colors duration-200',
                density === 'list'
                  ? 'bg-[var(--studio-surface-hover)] text-[var(--studio-fg)]'
                  : 'text-[var(--studio-muted)] hover:text-[var(--studio-fg)]',
              )}
            >
              <List className="size-16" aria-hidden />
            </button>
          </div>
        </div>

        {/* Rendered unconditionally: a live region only announces changes to
            text it already owns, so it has to exist before the list settles. */}
        <p className="sr-only" aria-live="polite">
          {listAnnouncement({ loading, error, count: filtered.length, noun: 'project' })}
        </p>

        {loading && (
          <div
            role="status"
            aria-label="Loading projects"
            className={
              density === 'grid'
                ? 'grid grid-cols-1 gap-16 sm:grid-cols-2 lg:grid-cols-3'
                : 'flex flex-col gap-10'
            }
          >
            {[0, 1, 2, 3].map((key) => (
              <div
                key={key}
                aria-hidden
                className="h-200 rounded-12 bg-[var(--studio-skeleton)] animate-pulse"
              />
            ))}
          </div>
        )}

        {!loading && error && (
          <div className="flex flex-col items-start gap-8" role="alert">
            <p className="text-[15px] text-[var(--studio-danger)]">{error}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex min-h-[44px] items-center rounded-full border border-[var(--studio-line-strong)] px-14 text-[13px] font-medium text-[var(--studio-fg)] hover:bg-[var(--studio-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
            >
              Try again
            </button>
          </div>
        )}

        {!loading && !error && filtered.length === 0 && (
          <div className="rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] px-28 py-56 text-center">
            {/* The heading names the active filter — a user with 18 projects who
                clicks Starred must not be told "No projects yet". */}
            <h2 className="text-[24px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">
              {search.trim()
                ? 'Nothing found'
                : starred
                  ? 'No starred projects'
                  : mine === true
                    ? "You don't own any projects yet"
                    : mine === false
                      ? 'Nothing has been shared with you yet'
                      : 'No projects yet'}
            </h2>
            <p className="mx-auto mt-10 max-w-[420px] text-[15px] leading-6 text-[var(--studio-muted)]">
              {search.trim()
                ? 'Try a different search, or clear it to see every project.'
                : starred
                  ? 'Star a project from its card menu and it will show up here.'
                  : 'Describe what you want to build on the dashboard and the project will show up here. Deleted projects are kept for 30 days before being permanently removed.'}
            </p>
            <StudioButton className="mt-20" href="/dashboard?focus=prompt">
              Go to dashboard
            </StudioButton>
          </div>
        )}

        {!loading &&
          buckets.map((bucket) => (
            <section key={bucket.heading} className="mb-32">
              <h2 className="mb-14 text-[13px] font-medium uppercase tracking-[0.06em] text-[var(--studio-faint)]">
                {bucket.heading}
              </h2>
              <div
                className={
                  density === 'grid'
                    ? 'grid grid-cols-1 gap-16 sm:grid-cols-2 lg:grid-cols-3'
                    : 'flex flex-col gap-10'
                }
              >
                {bucket.items.map((project) => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    density={density}
                    onRenamed={onRenamed}
                    onDuplicated={onDuplicated}
                    onDeleted={onDeleted}
                    onStarred={onStarred}
                  />
                ))}
              </div>
            </section>
          ))}
      </main>
    </StudioShell>
  );
}

export default function ProjectsPage() {
  return (
    <Suspense
      fallback={
        <StudioShell variant="workspace">
          <main className="mx-auto max-w-[1100px] px-20 pb-64 pt-40">
            <div className="h-40 w-160 rounded-10 bg-[var(--studio-skeleton)] animate-pulse" />
          </main>
        </StudioShell>
      }
    >
      <ProjectsContent />
    </Suspense>
  );
}
