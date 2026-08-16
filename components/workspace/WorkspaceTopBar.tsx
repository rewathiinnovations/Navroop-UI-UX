'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Check,
  Code2,
  Github,
  Globe,
  History,
  Loader2,
  Monitor,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Smartphone,
} from 'lucide-react';
import { cn } from '@/utils/cn';
import { pushProjectToGitHub } from '@/lib/github/actions';
import { relativeTime } from '@/lib/projects/prompt';
import Hint from './Hint';
import type { SaveStatus, ViewportSize, WorkspacePage, WorkspaceView } from './types';

function NavroopMark() {
  return (
    <Link
      href="/dashboard"
      aria-label="Navroop dashboard"
      className="inline-flex size-32 shrink-0 items-center justify-center rounded-10 transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
    >
      <svg viewBox="0 0 32 32" className="size-22" fill="none" aria-hidden>
        <defs>
          <linearGradient id="navroopWorkspaceMark" x1="6" y1="2" x2="26" y2="30" gradientUnits="userSpaceOnUse">
            <stop stopColor="#FF8A3D" />
            <stop offset="0.48" stopColor="#FF5C7A" />
            <stop offset="1" stopColor="#C084FC" />
          </linearGradient>
        </defs>
        <path
          d="M16.2 27.4c-6.4-4.6-10.7-8.9-10.7-14.1C5.5 9.2 8.6 6.4 12.2 6.4c2.1 0 3.9.9 5 2.4 1.1-1.5 2.9-2.4 5-2.4 3.6 0 6.7 2.8 6.7 6.9 0 5.2-4.3 9.5-10.7 14.1-.6.4-1.4.4-2 0Z"
          fill="url(#navroopWorkspaceMark)"
        />
      </svg>
    </Link>
  );
}

function saveLabel(saveState: SaveStatus, updatedAt: string | null) {
  if (saveState === 'saving') return 'Saving…';
  if (saveState === 'saved') return 'All changes saved';
  if (saveState === 'signin') return 'Sign in to save';
  if (updatedAt) return `Last saved ${relativeTime(updatedAt)}`;
  return null;
}

export default function WorkspaceTopBar({
  projectName,
  saveState,
  updatedAt,
  onRename,
  view,
  onViewChange,
  pages,
  selectedPage,
  onSelectPage,
  viewport,
  onViewportChange,
  chatCollapsed,
  onToggleChat,
  onOpenHistory,
  onRefresh,
  onShare,
  projectId,
  githubConnected = false,
  githubRepoUrl = null,
}: {
  projectName: string;
  saveState: SaveStatus;
  updatedAt: string | null;
  onRename: (name: string) => void;
  view: WorkspaceView;
  onViewChange: (view: WorkspaceView) => void;
  pages: WorkspacePage[];
  selectedPage: string;
  onSelectPage: (path: string) => void;
  viewport: ViewportSize;
  onViewportChange: (viewport: ViewportSize) => void;
  chatCollapsed: boolean;
  onToggleChat: () => void;
  onOpenHistory: () => void;
  onRefresh: () => void;
  onShare?: () => void;
  projectId?: string | null;
  githubConnected?: boolean;
  githubRepoUrl?: string | null;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(projectName);
  const [connectOpen, setConnectOpen] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pushSuccess, setPushSuccess] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [repoUrl, setRepoUrl] = useState(githubRepoUrl);
  const connectRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setRepoUrl(githubRepoUrl);
  }, [githubRepoUrl]);

  useEffect(() => {
    if (!connectOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (!connectRef.current?.contains(event.target as Node)) {
        setConnectOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setConnectOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [connectOpen]);

  useEffect(() => {
    setDraft(projectName);
  }, [projectName]);

  const commit = () => {
    const next = draft.trim() || 'Untitled project';
    setDraft(next);
    if (next !== projectName) onRename(next);
  };

  const status = saveLabel(saveState, updatedAt);

  return (
    <header className="relative z-20 flex h-52 shrink-0 items-center gap-12 border-b border-[var(--studio-line)] bg-[var(--studio-header-bg)] px-12 backdrop-blur-xl">
      <div className="flex min-w-0 flex-1 items-center gap-8">
        <NavroopMark />
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
          aria-label="Project name"
          className={cn(
            'min-w-0 max-w-[220px] truncate rounded-8 border border-transparent bg-transparent px-8 py-4',
            'text-[14px] font-medium text-[var(--studio-fg)]',
            'hover:border-[var(--studio-line)]',
            'focus-visible:border-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]',
          )}
        />
        {status && (
          <span className="hidden truncate text-[12px] text-[var(--studio-faint)] lg:inline">
            {saveState === 'signin' ? (
              <Link href="/?auth=login&next=/dashboard" className="text-[var(--studio-accent)] hover:underline">
                {status}
              </Link>
            ) : (
              status
            )}
          </span>
        )}
        <Hint label="Version history">
          <button
            type="button"
            onClick={onOpenHistory}
            aria-label="Version history"
            className="inline-flex size-36 items-center justify-center rounded-10 text-[var(--studio-muted)] hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)]"
          >
            <History className="size-16" />
          </button>
        </Hint>
        <Hint label={chatCollapsed ? 'Show chat' : 'Collapse chat'}>
          <button
            type="button"
            onClick={onToggleChat}
            aria-label={chatCollapsed ? 'Show chat' : 'Collapse chat'}
            className="inline-flex size-36 items-center justify-center rounded-10 text-[var(--studio-muted)] hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)]"
          >
            {chatCollapsed ? <PanelLeftOpen className="size-16" /> : <PanelLeftClose className="size-16" />}
          </button>
        </Hint>
      </div>

      <div className="flex items-center gap-8">
        <div className="inline-flex rounded-10 bg-[var(--studio-bg)] p-2">
          <button
            type="button"
            onClick={() => onViewChange('preview')}
            className={cn(
              'inline-flex items-center gap-6 rounded-8 px-10 py-6 text-[12px] font-medium transition-colors',
              view === 'preview'
                ? 'bg-[var(--studio-surface)] text-[var(--studio-fg)] shadow-sm'
                : 'text-[var(--studio-muted)] hover:text-[var(--studio-fg)]',
            )}
          >
            <Globe className="size-14" />
            Preview
          </button>
          <button
            type="button"
            onClick={() => onViewChange('code')}
            className={cn(
              'inline-flex items-center gap-6 rounded-8 px-10 py-6 text-[12px] font-medium transition-colors',
              view === 'code'
                ? 'bg-[var(--studio-surface)] text-[var(--studio-fg)] shadow-sm'
                : 'text-[var(--studio-muted)] hover:text-[var(--studio-fg)]',
            )}
          >
            <Code2 className="size-14" />
            Code
          </button>
        </div>
        <label className="sr-only" htmlFor="workspace-page">
          Page
        </label>
        <select
          id="workspace-page"
          value={selectedPage}
          onChange={(event) => onSelectPage(event.target.value)}
          className="h-36 max-w-[160px] rounded-10 border border-[var(--studio-line)] bg-[var(--studio-surface)] px-8 text-[12px] text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
        >
          {pages.map((page) => (
            <option key={page.path} value={page.path}>
              {page.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex min-w-0 flex-1 items-center justify-end gap-6">
        <Hint label={viewport === 'desktop' ? 'Desktop preview' : 'Mobile preview'}>
          <button
            type="button"
            onClick={() => onViewportChange(viewport === 'desktop' ? 'mobile' : 'desktop')}
            aria-label={viewport === 'desktop' ? 'Switch to mobile viewport' : 'Switch to desktop viewport'}
            className="inline-flex size-36 items-center justify-center rounded-10 text-[var(--studio-muted)] hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)]"
          >
            {viewport === 'desktop' ? <Monitor className="size-16" /> : <Smartphone className="size-16" />}
          </button>
        </Hint>
        <Hint label="Refresh preview">
          <button
            type="button"
            onClick={onRefresh}
            aria-label="Refresh preview"
            className="inline-flex size-36 items-center justify-center rounded-10 text-[var(--studio-muted)] hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)]"
          >
            <RefreshCw className="size-16" />
          </button>
        </Hint>
        <div className="relative flex flex-col items-end" ref={connectRef}>
          <div className="flex items-center gap-6">
            {githubConnected ? (
              <Hint label={pushing ? 'Pushing…' : 'Push to GitHub'}>
                <button
                  type="button"
                  disabled={pushing || !projectId}
                  onClick={() => {
                    if (!projectId || pushing) return;
                    setPushError(null);
                    setPushing(true);
                    void pushProjectToGitHub(projectId)
                      .then((result) => {
                        if (!result.ok) {
                          setPushError(result.error || 'Push failed, try again');
                          return;
                        }
                        if (result.data.githubRepoUrl) setRepoUrl(result.data.githubRepoUrl);
                        setPushSuccess(true);
                        router.refresh();
                        window.setTimeout(() => setPushSuccess(false), 2000);
                      })
                      .finally(() => setPushing(false));
                  }}
                  aria-label="Push to GitHub"
                  className="inline-flex size-36 items-center justify-center rounded-10 text-[var(--studio-muted)] hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {pushing ? (
                    <Loader2 className="size-16 animate-spin" />
                  ) : pushSuccess ? (
                    <Check className="size-16 text-[var(--studio-fg)]" />
                  ) : (
                    <Github className="size-16" />
                  )}
                </button>
              </Hint>
            ) : (
              <button
                type="button"
                aria-expanded={connectOpen}
                aria-haspopup="dialog"
                aria-label="Push to GitHub"
                onClick={() => setConnectOpen((open) => !open)}
                className="inline-flex size-36 items-center justify-center rounded-10 text-[var(--studio-muted)] hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)]"
              >
                <Github className="size-16" />
              </button>
            )}
            {repoUrl && (
              <a
                href={repoUrl}
                target="_blank"
                rel="noreferrer"
                className="whitespace-nowrap text-[12px] font-medium text-[var(--studio-accent)] hover:underline"
              >
                View on GitHub
              </a>
            )}
          </div>
          {pushError && (
            <p className="absolute top-full right-0 z-30 mt-4 max-w-[240px] text-right text-[11px] leading-4 text-[var(--studio-danger)]" role="alert">
              {pushError}
            </p>
          )}
          {!githubConnected && connectOpen && (
            <div
              role="dialog"
              className="absolute top-full right-0 z-40 mt-8 w-[240px] rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] p-12 shadow-sm"
            >
              <p className="text-[13px] leading-5 text-[var(--studio-fg)]">
                Connect GitHub to push this project
              </p>
              <Link
                href="/connectors"
                className="mt-8 inline-flex text-[13px] font-medium text-[var(--studio-accent)] hover:underline"
              >
                Go to Connectors
              </Link>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onShare}
          className="inline-flex h-36 items-center rounded-full border border-[var(--studio-line-strong)] px-14 text-[13px] font-medium text-[var(--studio-fg)] hover:bg-[var(--studio-surface-hover)]"
        >
          Share
        </button>
        <Hint label="Coming soon">
          <button
            type="button"
            disabled
            className="inline-flex h-36 items-center rounded-full bg-[var(--studio-fg)] px-14 text-[13px] font-medium text-[var(--studio-bg)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Publish
          </button>
        </Hint>
      </div>
    </header>
  );
}
