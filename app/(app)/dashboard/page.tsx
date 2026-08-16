"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import StudioShell from "@/components/app/studio/StudioShell";
import PromptHero from "@/components/dashboard/PromptHero";
import ProjectCard from "@/components/dashboard/ProjectCard";
import { loginModalHref } from "@/lib/auth/public-login";
import { PENDING_PROMPT_KEY, clearDraftStorage } from "@/hooks/useDraftStorage";
import { createProject } from "@/lib/projects/actions";
import type { StackId } from "@/lib/stacks";
import {
  fetchProjectList,
  isProjectGenerating,
  type ListProject,
} from "@/lib/projects/list-client";

type DashTab = "mine" | "recent" | "templates";

export default function DashboardPage() {
  const router = useRouter();
  const { data: session } = useSession();
  const [tab, setTab] = useState<DashTab>("mine");
  const [projects, setProjects] = useState<ListProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const firstName =
    session?.user?.name?.trim().split(/\s+/)[0] ||
    session?.user?.email?.split("@")[0] ||
    "there";
  const userId = session?.user?.id;

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    const result = await fetchProjectList({ sort: "updatedAt" });
    if (!result.ok) {
      if (result.status === 401) {
        router.push(loginModalHref("/dashboard"));
        return;
      }
      setError(result.error);
      if (!silent) setLoading(false);
      return;
    }
    setProjects(result.projects);
    setError("");
    if (!silent) setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!projects.some(isProjectGenerating)) return;
    const timer = setInterval(() => {
      void load(true);
    }, 4000);
    return () => clearInterval(timer);
  }, [projects]);

  const mine = useMemo(() => {
    const owned = userId ? projects.filter((project) => project.ownerId === userId) : projects;
    return owned.slice(0, 8);
  }, [projects, userId]);

  const recent = useMemo(() => projects.slice(0, 8), [projects]);
  const visible = tab === "mine" ? mine : recent;

  const onSubmit = async (text: string, stack: StackId) => {
    setError("");
    const created = await createProject({ initialPrompt: text, stack });
    if (!created.ok) {
      if (created.status === 401) {
        router.push(loginModalHref("/dashboard"));
        return;
      }
      setError(created.error);
      return;
    }
    clearDraftStorage(PENDING_PROMPT_KEY);
    router.push(`/project/${created.data.id}`);
  };

  const onRenamed = (id: string, name: string) => {
    setProjects((current) => current.map((project) => (project.id === id ? { ...project, name } : project)));
  };

  const onDuplicated = (project: ListProject) => {
    setProjects((current) => [project, ...current]);
  };

  const onDeleted = (id: string) => {
    setProjects((current) => current.filter((project) => project.id !== id));
  };

  return (
    <StudioShell variant="workspace">
      <main className="mx-auto max-w-[960px] px-20 pb-64">
        <div className="pt-56 pb-40">
          <PromptHero greeting={`What's on your mind, ${firstName}?`} onSubmit={onSubmit} />
          {error && (
            <p className="mt-12 text-center text-[14px] text-[var(--studio-danger)]" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="mb-20 flex flex-wrap items-center justify-between gap-12">
          <nav className="flex gap-4 border-b border-[var(--studio-line)]" aria-label="Project views">
            {(
              [
                ["mine", "My projects"],
                ["recent", "Recently viewed"],
                ["templates", "Templates"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`inline-flex min-h-[44px] items-center px-8 text-[14px] transition-colors duration-200 ${
                  tab === id
                    ? "border-b-2 border-[var(--studio-fg)] text-[var(--studio-fg)]"
                    : "text-[var(--studio-muted)] hover:text-[var(--studio-fg)]"
                }`}
              >
                {label}
              </button>
            ))}
          </nav>
          {tab !== "templates" && (
            <Link
              href="/projects"
              className="text-[13px] text-[var(--studio-muted)] hover:text-[var(--studio-fg)] transition-colors duration-200"
            >
              Browse all
            </Link>
          )}
        </div>

        {tab === "templates" ? (
          <div className="rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] px-28 py-56 text-center">
            <h2 className="text-[24px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">
              Templates
            </h2>
            <p className="mt-12 text-[15px] text-[var(--studio-muted)]">Coming soon</p>
          </div>
        ) : (
          <>
            {loading && (
              <div className="grid grid-cols-1 gap-16 sm:grid-cols-2 lg:grid-cols-3">
                {[0, 1, 2, 3].map((key) => (
                  <div key={key} className="h-240 rounded-12 bg-[var(--studio-skeleton)] animate-pulse" />
                ))}
              </div>
            )}

            {!loading && visible.length === 0 && (
              <div className="rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] px-28 py-56 text-center">
                <h2 className="text-[24px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">
                  No projects yet
                </h2>
                <p className="mx-auto mt-10 max-w-[420px] text-[15px] leading-6 text-[var(--studio-muted)]">
                  Describe what you want to build above. It will appear here automatically.
                </p>
              </div>
            )}

            {!loading && visible.length > 0 && (
              <div className="grid grid-cols-1 gap-16 sm:grid-cols-2 lg:grid-cols-3">
                {visible.map((project) => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    onRenamed={onRenamed}
                    onDuplicated={onDuplicated}
                    onDeleted={onDeleted}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </StudioShell>
  );
}
