"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { LayoutGrid, List, Plus } from "lucide-react";
import StudioButton from "@/components/app/studio/StudioButton";
import StudioShell from "@/components/app/studio/StudioShell";
import ProjectCard from "@/components/dashboard/ProjectCard";
import {
  bucketProjectsByUpdatedAt,
  fetchProjectList,
  isProjectGenerating,
  type ListProject,
} from "@/lib/projects/list-client";
import { cn } from "@/utils/cn";

type SortKey = "updatedAt" | "name" | "createdAt";
type StatusFilter = "any" | "draft" | "published";
type Density = "grid" | "list";

function parseSort(value: string | null): SortKey {
  if (value === "name" || value === "createdAt" || value === "updatedAt") return value;
  return "updatedAt";
}

function parseStatus(value: string | null): StatusFilter {
  if (value === "draft" || value === "published") return value;
  return "any";
}

function parseMine(value: string | null): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function ProjectsContent() {
  const searchParams = useSearchParams();
  const [search, setSearch] = useState(searchParams.get("search") ?? "");
  const [sort, setSort] = useState<SortKey>(parseSort(searchParams.get("sort")));
  const [status, setStatus] = useState<StatusFilter>(parseStatus(searchParams.get("status")));
  const [mine, setMine] = useState<boolean | undefined>(parseMine(searchParams.get("mine")));
  const starred = searchParams.get("starred") === "true";
  const [density, setDensity] = useState<Density>("grid");
  const [createOpen, setCreateOpen] = useState(false);
  const [projects, setProjects] = useState<ListProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setSearch(searchParams.get("search") ?? "");
    setSort(parseSort(searchParams.get("sort")));
    setStatus(parseStatus(searchParams.get("status")));
    setMine(parseMine(searchParams.get("mine")));
  }, [searchParams]);

  useEffect(() => {
    if (!createOpen) return;
    const close = () => setCreateOpen(false);
    const timer = window.setTimeout(() => {
      document.addEventListener("click", close);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("click", close);
    };
  }, [createOpen]);

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
      const nextMine = "mine" in patch ? patch.mine : mine;
      if (nextSearch) params.set("search", nextSearch);
      if (nextSort !== "updatedAt") params.set("sort", nextSort);
      if (nextStatus !== "any") params.set("status", nextStatus);
      if (nextMine === true) params.set("mine", "true");
      if (nextMine === false) params.set("mine", "false");
      if (starred) params.set("starred", "true");
      const qs = params.toString();
      window.history.replaceState(null, "", qs ? `/projects?${qs}` : "/projects");
    },
    [mine, search, sort, starred, status],
  );

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
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
      setError("");
      if (!silent) setLoading(false);
    },
    [mine, search, sort, starred],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, search ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [load, search]);

  useEffect(() => {
    if (!projects.some(isProjectGenerating)) return;
    const timer = setInterval(() => {
      void load(true);
    }, 4000);
    return () => clearInterval(timer);
  }, [load, projects]);

  const filtered = useMemo(() => {
    if (status === "any") return projects;
    return projects.filter((project) => project.status === status);
  }, [projects, status]);

  const buckets = useMemo(() => bucketProjectsByUpdatedAt(filtered), [filtered]);

  const onRenamed = (id: string, name: string) => {
    setProjects((current) => current.map((project) => (project.id === id ? { ...project, name } : project)));
  };

  const onDuplicated = (project: ListProject) => {
    setProjects((current) => [project, ...current]);
  };

  const onDeleted = (id: string) => {
    setProjects((current) => current.filter((project) => project.id !== id));
  };

  const selectClass =
    "h-44 rounded-10 border border-[var(--studio-line)] bg-[var(--studio-surface)] px-12 text-[14px] text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]";

  return (
    <StudioShell variant="workspace">
      <main className="mx-auto max-w-[1100px] px-20 pb-64 pt-40">
        <div className="mb-24 flex flex-wrap items-center justify-between gap-12">
          <h1 className="text-[32px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">
            Projects
          </h1>
          <div className="relative">
            <StudioButton variant="primary" onClick={() => setCreateOpen((open) => !open)}>
              <Plus className="size-16" aria-hidden />
              Create
            </StudioButton>
            {createOpen && (
              <div
                role="menu"
                className="absolute right-0 z-20 mt-8 w-200 overflow-hidden rounded-10 border border-[var(--studio-line)] bg-[var(--studio-surface)] shadow-[0_12px_24px_rgba(24,24,27,0.12)]"
              >
                <Link
                  href="/dashboard?focus=prompt"
                  role="menuitem"
                  className="flex min-h-[44px] items-center px-14 text-[14px] text-[var(--studio-fg)] hover:bg-[var(--studio-surface-hover)]"
                  onClick={() => setCreateOpen(false)}
                >
                  Blank project
                </Link>
              </div>
            )}
          </div>
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
                value={mine === true ? "mine" : "all"}
                onChange={(event) => {
                  const next = event.target.value === "mine" ? true : undefined;
                  setMine(next);
                  persistUrl({ mine: next });
                }}
                className={selectClass}
              >
                <option value="all">All</option>
                <option value="mine">Just mine</option>
              </select>
            </label>
          </div>
          <div className="inline-flex rounded-10 border border-[var(--studio-line)] p-4" role="group" aria-label="Layout">
            <button
              type="button"
              aria-pressed={density === "grid"}
              aria-label="Grid view"
              onClick={() => setDensity("grid")}
              className={cn(
                "inline-flex size-[36px] items-center justify-center rounded-8 transition-colors duration-200",
                density === "grid"
                  ? "bg-[var(--studio-surface-hover)] text-[var(--studio-fg)]"
                  : "text-[var(--studio-muted)] hover:text-[var(--studio-fg)]",
              )}
            >
              <LayoutGrid className="size-16" aria-hidden />
            </button>
            <button
              type="button"
              aria-pressed={density === "list"}
              aria-label="List view"
              onClick={() => setDensity("list")}
              className={cn(
                "inline-flex size-[36px] items-center justify-center rounded-8 transition-colors duration-200",
                density === "list"
                  ? "bg-[var(--studio-surface-hover)] text-[var(--studio-fg)]"
                  : "text-[var(--studio-muted)] hover:text-[var(--studio-fg)]",
              )}
            >
              <List className="size-16" aria-hidden />
            </button>
          </div>
        </div>

        {loading && (
          <div className={density === "grid" ? "grid grid-cols-1 gap-16 sm:grid-cols-2 lg:grid-cols-3" : "flex flex-col gap-10"}>
            {[0, 1, 2, 3].map((key) => (
              <div key={key} className="h-200 rounded-12 bg-[var(--studio-skeleton)] animate-pulse" />
            ))}
          </div>
        )}

        {!loading && error && (
          <p className="text-[15px] text-[var(--studio-danger)]" role="alert">
            {error}
          </p>
        )}

        {!loading && !error && filtered.length === 0 && (
          <div className="rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] px-28 py-56 text-center">
            <h2 className="text-[24px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">
              No projects yet
            </h2>
            <p className="mx-auto mt-10 max-w-[420px] text-[15px] leading-6 text-[var(--studio-muted)]">
              Start a blank project and it will show up here. Deleted projects:
              30 din baad apne aap hamesha ke liye delete ho jayega.
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
                  density === "grid"
                    ? "grid grid-cols-1 gap-16 sm:grid-cols-2 lg:grid-cols-3"
                    : "flex flex-col gap-10"
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
