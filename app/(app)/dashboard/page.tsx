'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import StudioShell from '@/components/app/studio/StudioShell';
import PromptHero, { type PromptHeroHandle } from '@/components/dashboard/PromptHero';
import SetupChecklist from '@/components/dashboard/SetupChecklist';
import ExamplePromptCards from '@/components/dashboard/ExamplePromptCards';
import PromptTipsPanel from '@/components/dashboard/PromptTipsPanel';
import ProjectCard from '@/components/dashboard/ProjectCard';
import { loginModalHref } from '@/lib/auth/public-login';
import { notify } from '@/lib/notify';
import { PENDING_PROMPT_KEY, clearDraftStorage } from '@/hooks/useDraftStorage';
import type { DesignDirectionId } from '@/lib/design/directions';
import type { ImportMode } from '@/lib/import/mode';
import { createProject } from '@/lib/projects/actions';
import { armProjectGeneration } from '@/lib/projects/start-from-prompt';
import type { StackId } from '@/lib/stacks';
import {
  fetchProjectList,
  isProjectGenerating,
  type ListProject,
} from '@/lib/projects/list-client';

type DashTab = 'mine' | 'recent' | 'templates';

export default function DashboardPage() {
  const router = useRouter();
  const { data: session } = useSession();
  const [tab, setTab] = useState<DashTab>('mine');
  const [projects, setProjects] = useState<ListProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const heroRef = useRef<PromptHeroHandle>(null);

  const firstName =
    session?.user?.name?.trim().split(/\s+/)[0] || session?.user?.email?.split('@')[0] || 'there';
  const userId = session?.user?.id;

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    const result = await fetchProjectList({ sort: 'updatedAt' });
    if (!result.ok) {
      if (result.status === 401) {
        router.push(loginModalHref('/dashboard'));
        return;
      }
      setError(result.error);
      if (!silent) setLoading(false);
      return;
    }
    setProjects(result.projects);
    setError('');
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
  const visible = tab === 'mine' ? mine : recent;

  const onSubmit = async (
    text: string,
    stack: StackId,
    designDirection: DesignDirectionId,
    importMode: ImportMode,
  ) => {
    // No `templateId`: template attribution belongs to the sheet's own create call
    // (`POST /api/templates/[id]/create`). This used to read it back out of the shared hero
    // draft, which the template sheet wrote into — so the next unrelated prompt sent from the
    // dashboard was filed against, and counted a second use of, a template it had nothing to
    // do with.
    const created = await createProject({
      initialPrompt: text,
      stack,
      designDirection,
      importMode,
      // Land in the workspace immediately; the plan streams in behind it.
      deferPlanning: true,
    });
    if (!created.ok) {
      if (created.status === 401) {
        router.push(loginModalHref('/dashboard'));
        return;
      }
      // Toasted rather than inlined: the prompt hero is about to scroll away,
      // and the failure has to stay readable wherever the user lands.
      notify.error(created.error, { key: 'create-project' });
      return;
    }
    clearDraftStorage(PENDING_PROMPT_KEY);
    armProjectGeneration(created.data.id, text);
    router.push(`/project/${created.data.id}`);
  };

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

  const onStarred = (id: string, starred: boolean) => {
    setProjects((current) =>
      current.map((project) => (project.id === id ? { ...project, starred } : project)),
    );
  };

  return (
    <StudioShell variant="workspace">
      <main className="mx-auto max-w-[960px] px-20 pb-64">
        <div className="pt-56 pb-40">
          <SetupChecklist />
          <PromptTipsPanel />
          <PromptHero
            ref={heroRef}
            greeting={`What's on your mind, ${firstName}?`}
            onSubmit={onSubmit}
          />
          {error && (
            <p className="mt-12 text-center text-[14px] text-[var(--studio-danger)]" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="mb-20 flex flex-wrap items-center justify-between gap-12">
          <nav
            className="flex gap-4 border-b border-[var(--studio-line)]"
            aria-label="Project views"
          >
            {(
              [
                ['mine', 'My projects'],
                ['recent', 'Recently viewed'],
                ['templates', 'Templates'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`inline-flex min-h-[44px] items-center px-8 text-[14px] transition-colors duration-200 ${
                  tab === id
                    ? 'border-b-2 border-[var(--studio-fg)] text-[var(--studio-fg)]'
                    : 'text-[var(--studio-muted)] hover:text-[var(--studio-fg)]'
                }`}
              >
                {label}
              </button>
            ))}
          </nav>
          {tab !== 'templates' && (
            <Link
              href="/projects"
              className="text-[13px] text-[var(--studio-muted)] hover:text-[var(--studio-fg)] transition-colors duration-200"
            >
              Browse all
            </Link>
          )}
        </div>

        {tab === 'templates' ? (
          <div className="rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] px-28 py-40 text-center">
            <h2 className="text-[24px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">
              Templates
            </h2>
            <p className="mx-auto mt-10 max-w-[420px] text-[15px] leading-6 text-[var(--studio-muted)]">
              Start from a restaurant, clinic, portfolio, or another detailed brief.
            </p>
            <Link
              href="/templates"
              className="mt-16 inline-flex text-[14px] font-medium text-[var(--studio-accent)] hover:underline"
            >
              Browse templates
            </Link>
          </div>
        ) : (
          <>
            {loading && (
              <div className="grid grid-cols-1 gap-16 sm:grid-cols-2 lg:grid-cols-3">
                {[0, 1, 2, 3].map((key) => (
                  <div
                    key={key}
                    className="h-240 rounded-12 bg-[var(--studio-skeleton)] animate-pulse"
                  />
                ))}
              </div>
            )}

            {!loading && visible.length === 0 && (
              <div className="rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] px-28 py-40">
                <h2 className="text-center text-[24px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">
                  Welcome to {process.env.NEXT_PUBLIC_WORKSPACE_NAME || 'Navroop'}
                </h2>
                <p className="mx-auto mt-10 max-w-[480px] text-center text-[15px] leading-6 text-[var(--studio-muted)]">
                  Start with a detailed prompt. Click a card to fill the box — nothing generates
                  until you send it.
                </p>
                <div className="mt-20">
                  <ExamplePromptCards
                    onChoose={(prompt) => {
                      // `fill` already flushes the draft, and it does so with the stack and
                      // design direction the hero is actually showing.
                      heroRef.current?.fill(prompt);
                    }}
                  />
                </div>
                <p className="mt-20 text-center">
                  <Link
                    href="/templates"
                    className="text-[14px] font-medium text-[var(--studio-accent)] hover:underline"
                  >
                    Browse templates
                  </Link>
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
                    onStarred={onStarred}
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
