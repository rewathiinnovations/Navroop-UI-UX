'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Check,
  Code2,
  Eye,
  FileText,
  Github,
  History,
  Loader2,
  ChevronDown,
  ExternalLink,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  Images,
  Brain,
  Link2,
  MoreHorizontal,
} from 'lucide-react';
import SaveAsTemplateDialog from '@/components/templates/SaveAsTemplateDialog';
import { downloadProjectZip, formatExportBytes } from '@/lib/export/client';
import { cn } from '@/utils/cn';
import { pushProjectToGitHub } from '@/lib/github/actions';
import { relativeTime } from '@/lib/projects/prompt';
import Hint from './Hint';
import PreviewDeviceToolbar from './PreviewDeviceToolbar';
import PublishPanel from './PublishPanel';
import {
  formatPreviewSize,
  getPreviewDevice,
  openPreviewWindow,
  rotateDeviceSize,
  type PreviewDeviceKey,
} from '@/lib/preview/devices';
import {
  WORKSPACE_PRIMARY_TABS,
  WORKSPACE_TOOL_TABS,
  type SaveStatus,
  type WorkspacePage,
  type WorkspaceView,
} from './types';
import PresenceAvatars from './PresenceAvatars';
import type { PresenceViewer } from './useProjectPresence';
import { LIVE_MODE_LABEL, LIVE_MODE_TOOLTIP } from '@/lib/preview/labels';

const TAB_ICONS: Record<WorkspaceView, typeof Eye> = {
  preview: Eye,
  code: Code2,
  seo: Search,
  assets: Images,
  brain: Brain,
  domains: Link2,
};

const ICON_BTN =
  'inline-flex size-32 items-center justify-center rounded-full text-[var(--studio-muted)] transition-colors hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)] disabled:cursor-not-allowed disabled:opacity-40';

function BarDivider() {
  return <span className="mx-2 h-16 w-px shrink-0 bg-[var(--studio-line)]" aria-hidden />;
}

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
  chatCollapsed,
  onToggleChat,
  onOpenHistory,
  onRefresh,
  onShare,
  previewUrl = null,
  previewDevice = 'desktop',
  previewRotated = false,
  onPreviewDeviceChange,
  onTogglePreviewRotate,
  projectId,
  githubConnected = false,
  githubRepoUrl = null,
  sourceUrl = null,
  presenceViewers = [],
  liveMode = false,
  liveModeLocked = false,
  liveModeReason = null,
  onToggleLiveMode,
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
  chatCollapsed: boolean;
  onToggleChat: () => void;
  onOpenHistory: () => void;
  onRefresh: () => void;
  onShare?: () => void;
  previewUrl?: string | null;
  previewDevice?: PreviewDeviceKey;
  previewRotated?: boolean;
  onPreviewDeviceChange?: (key: PreviewDeviceKey) => void;
  onTogglePreviewRotate?: () => void;
  projectId?: string | null;
  githubConnected?: boolean;
  githubRepoUrl?: string | null;
  sourceUrl?: string | null;
  presenceViewers?: PresenceViewer[];
  liveMode?: boolean;
  liveModeLocked?: boolean;
  liveModeReason?: string | null;
  onToggleLiveMode?: () => void;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(projectName);
  const [connectOpen, setConnectOpen] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pushSuccess, setPushSuccess] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [repoUrl, setRepoUrl] = useState(githubRepoUrl);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportHint, setExportHint] = useState<string | null>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const [compactPreview, setCompactPreview] = useState(false);
  const connectRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);

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
    if (!previewOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (!previewRef.current?.contains(event.target as Node)) setPreviewOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreviewOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [previewOpen]);

  useEffect(() => {
    if (!moreOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMoreOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [moreOpen]);

  useEffect(() => {
    const node = headerRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      setCompactPreview(entry.contentRect.width < 1180);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

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
    <>
    <header
      ref={headerRef}
      className="relative z-30 flex h-56 shrink-0 items-center gap-8 overflow-visible border-b border-[var(--studio-line)] bg-[var(--studio-header-bg)] px-10 backdrop-blur-xl"
    >
      <div className="flex min-w-0 flex-1 items-center gap-6">
        <NavroopMark />
        <div className="flex min-w-0 flex-col justify-center">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
            aria-label="Project name"
            className={cn(
              'min-w-0 max-w-[200px] truncate rounded-8 border border-transparent bg-transparent px-4 py-0',
              'text-[13px] font-semibold leading-5 text-[var(--studio-fg)]',
              'hover:border-[var(--studio-line)]',
              'focus-visible:border-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]',
            )}
          />
          {status ? (
            <span className="hidden truncate px-4 text-[11px] leading-4 text-[var(--studio-faint)] xl:inline">
              {saveState === 'signin' ? (
                <Link href="/?auth=login&next=/dashboard" className="text-[var(--studio-accent)] hover:underline">
                  {status}
                </Link>
              ) : (
                status
              )}
            </span>
          ) : null}
        </div>
        {sourceUrl ? (
          <a
            href={sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="hidden max-w-[140px] truncate text-[11px] text-[var(--studio-accent)] hover:underline 2xl:inline"
          >
            {sourceUrl.replace(/^https?:\/\//i, "")}
          </a>
        ) : null}
        <BarDivider />
        <Hint label="Version history">
          <button
            type="button"
            onClick={onOpenHistory}
            aria-label="Version history"
            className={ICON_BTN}
          >
            <History className="size-16" />
          </button>
        </Hint>
        <Hint label={chatCollapsed ? 'Show chat' : 'Collapse chat'}>
          <button
            type="button"
            onClick={onToggleChat}
            aria-label={chatCollapsed ? 'Show chat' : 'Collapse chat'}
            className={ICON_BTN}
          >
            {chatCollapsed ? <PanelLeftOpen className="size-16" /> : <PanelLeftClose className="size-16" />}
          </button>
        </Hint>
      </div>

      <div className="flex shrink-0 items-center gap-6">
        <div
          role="tablist"
          aria-label="Workspace view"
          className="inline-flex h-36 items-center rounded-full border border-[var(--studio-line)] bg-[var(--studio-bg)] p-3"
        >
          {WORKSPACE_PRIMARY_TABS.map((tab) => {
            const Icon = TAB_ICONS[tab.id];
            const selected = view === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => onViewChange(tab.id)}
                className={cn(
                  'inline-flex h-30 items-center gap-6 rounded-full px-12 text-[13px] font-medium transition-colors',
                  selected
                    ? 'bg-[var(--studio-surface)] text-[var(--studio-fg)] shadow-sm'
                    : 'text-[var(--studio-muted)] hover:text-[var(--studio-fg)]',
                )}
              >
                <Icon className="size-14" />
                {tab.label}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2" aria-label="Workspace tools">
          {WORKSPACE_TOOL_TABS.map((tab) => {
            const Icon = TAB_ICONS[tab.id];
            const selected = view === tab.id;
            return (
              <Hint key={tab.id} label={tab.label}>
                <button
                  type="button"
                  aria-label={tab.label}
                  aria-pressed={selected}
                  onClick={() => onViewChange(tab.id)}
                  className={cn(
                    ICON_BTN,
                    selected && 'bg-[var(--studio-surface)] text-[var(--studio-fg)] shadow-sm',
                  )}
                >
                  <Icon className="size-15" />
                </button>
              </Hint>
            );
          })}
        </div>
        <div className={cn('relative items-center', compactPreview && projectId ? 'hidden' : 'flex')}>
          <FileText className="pointer-events-none absolute left-10 size-13 text-[var(--studio-muted)]" aria-hidden />
          <label className="sr-only" htmlFor="workspace-page">
            Page
          </label>
          <select
            id="workspace-page"
            value={selectedPage}
            onChange={(event) => onSelectPage(event.target.value)}
            className="h-32 max-w-[148px] appearance-none rounded-full border border-[var(--studio-line)] bg-[var(--studio-surface)] py-0 pr-28 pl-28 text-[12px] font-medium text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
          >
            {pages.map((page) => (
              <option key={page.path} value={page.path}>
                {page.label}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-10 size-13 text-[var(--studio-muted)]" aria-hidden />
        </div>
      </div>

      <div className="flex min-w-0 flex-1 items-center justify-end gap-4">
        <PresenceAvatars viewers={presenceViewers} />
        {view === 'preview' && onToggleLiveMode ? (
          <Hint label={liveModeLocked ? liveModeReason || LIVE_MODE_TOOLTIP : LIVE_MODE_TOOLTIP}>
            <button
              type="button"
              role="switch"
              aria-checked={liveMode}
              aria-label={LIVE_MODE_LABEL}
              disabled={liveModeLocked}
              onClick={onToggleLiveMode}
              className={cn(
                'inline-flex h-32 items-center gap-6 rounded-full px-10 text-[12px] font-medium transition-colors',
                liveMode
                  ? 'bg-[var(--studio-accent)] text-white'
                  : 'text-[var(--studio-muted)] hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)]',
                liveModeLocked && 'cursor-not-allowed opacity-80',
              )}
            >
              <span
                className={cn(
                  'size-6 rounded-full',
                  liveMode ? 'bg-white' : 'bg-[var(--studio-muted)] opacity-50',
                )}
                aria-hidden
              />
              <span className={cn(compactPreview && 'sr-only')}>{LIVE_MODE_LABEL}</span>
            </button>
          </Hint>
        ) : null}
        {view === 'preview' && onPreviewDeviceChange && onTogglePreviewRotate ? (
          <PreviewDeviceToolbar
            device={previewDevice}
            rotated={previewRotated}
            sizeLabel={(() => {
              const spec = getPreviewDevice(previewDevice);
              if (spec.width == null || spec.height == null) return '';
              const size = previewRotated ? rotateDeviceSize(spec.width, spec.height) : spec;
              return formatPreviewSize(size.width, size.height);
            })()}
            scaleLabel={null}
            compact={compactPreview}
            onDeviceChange={onPreviewDeviceChange}
            onToggleRotate={onTogglePreviewRotate}
          />
        ) : null}
        <Hint label="Refresh preview">
          <button
            type="button"
            onClick={onRefresh}
            aria-label="Refresh preview"
            className={ICON_BTN}
          >
            <RefreshCw className="size-15" />
          </button>
        </Hint>
        <div className="relative" ref={previewRef}>
          <div className="inline-flex items-center">
            <Hint label="Open in new tab">
              <button
                type="button"
                disabled={!previewUrl}
                onClick={() => previewUrl && openPreviewWindow(previewUrl)}
                aria-label="Open in new tab"
                className={ICON_BTN}
              >
                <ExternalLink className="size-15" />
              </button>
            </Hint>
            <button
              type="button"
              disabled={!previewUrl}
              aria-expanded={previewOpen}
              aria-haspopup="menu"
              aria-label="Open preview options"
              onClick={() => setPreviewOpen((value) => !value)}
              className={cn(ICON_BTN, 'size-24')}
            >
              <ChevronDown className="size-12" />
            </button>
          </div>
          {previewOpen && previewUrl ? (
            <div
              role="menu"
              className="absolute top-full right-0 z-40 mt-6 w-[168px] rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] p-4 shadow-sm"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  openPreviewWindow(previewUrl);
                  setPreviewOpen(false);
                }}
                className="flex w-full rounded-8 px-10 py-8 text-left text-[12px] text-[var(--studio-fg)] hover:bg-[var(--studio-surface-hover)]"
              >
                Full size
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const mobile = getPreviewDevice('mobile');
                  openPreviewWindow(previewUrl, {
                    width: mobile.width ?? 390,
                    height: mobile.height ?? 844,
                  });
                  setPreviewOpen(false);
                }}
                className="flex w-full rounded-8 px-10 py-8 text-left text-[12px] text-[var(--studio-fg)] hover:bg-[var(--studio-surface-hover)]"
              >
                Mobile view
              </button>
            </div>
          ) : null}
        </div>
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
                  className={ICON_BTN}
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
                className={ICON_BTN}
              >
                <Github className="size-16" />
              </button>
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
        {projectId ? (
          <div className="relative" ref={moreRef}>
            <button
              type="button"
              aria-expanded={moreOpen}
              aria-haspopup="menu"
              aria-label="Project actions"
              onClick={() => setMoreOpen((value) => !value)}
              className={ICON_BTN}
            >
              <MoreHorizontal className="size-16" />
            </button>
            {moreOpen ? (
              <div
                role="menu"
                className="absolute top-full right-0 z-40 mt-6 w-[200px] rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] p-4 shadow-sm"
              >
                {compactPreview ? (
                  <>
                    {pages.map((page) => (
                      <button
                        key={page.path}
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          onSelectPage(page.path);
                          setMoreOpen(false);
                        }}
                        className={cn(
                          'flex w-full rounded-8 px-10 py-8 text-left text-[12px] hover:bg-[var(--studio-surface-hover)]',
                          selectedPage === page.path
                            ? 'font-medium text-[var(--studio-fg)]'
                            : 'text-[var(--studio-muted)]',
                        )}
                      >
                        {page.label}
                      </button>
                    ))}
                    <div className="my-4 h-px bg-[var(--studio-line)]" />
                  </>
                ) : null}
                {repoUrl ? (
                  <a
                    href={repoUrl}
                    target="_blank"
                    rel="noreferrer"
                    role="menuitem"
                    onClick={() => setMoreOpen(false)}
                    className="flex w-full rounded-8 px-10 py-8 text-left text-[12px] text-[var(--studio-fg)] hover:bg-[var(--studio-surface-hover)]"
                  >
                    View on GitHub
                  </a>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMoreOpen(false);
                    setSaveTemplateOpen(true);
                  }}
                  className="flex w-full rounded-8 px-10 py-8 text-left text-[12px] text-[var(--studio-fg)] hover:bg-[var(--studio-surface-hover)]"
                >
                  Save as template
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={exporting || !projectId}
                  onClick={() => {
                    if (!projectId || exporting) return;
                    setExporting(true);
                    setExportHint(null);
                    void downloadProjectZip(projectId).then((result) => {
                      setExporting(false);
                      if (!result.ok) {
                        setExportHint(result.error);
                        return;
                      }
                      setExportHint(formatExportBytes(result.bytes));
                    });
                    setMoreOpen(false);
                  }}
                  className="flex w-full items-center justify-between rounded-8 px-10 py-8 text-left text-[12px] text-[var(--studio-fg)] hover:bg-[var(--studio-surface-hover)] disabled:opacity-50"
                >
                  <span>Download code</span>
                  {exporting ? <Loader2 className="size-14 animate-spin" /> : null}
                </button>
                {exportHint ? (
                  <p className="px-10 pb-6 text-[11px] text-[var(--studio-faint)]">{exportHint}</p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        <BarDivider />
        <button
          type="button"
          onClick={onShare}
          className="inline-flex h-32 items-center rounded-full border border-[var(--studio-line-strong)] px-12 text-[13px] font-medium text-[var(--studio-fg)] hover:bg-[var(--studio-surface-hover)]"
        >
          Share
        </button>
        <PublishPanel projectId={projectId} />
      </div>
    </header>
    {projectId ? (
      <SaveAsTemplateDialog
        projectId={projectId}
        open={saveTemplateOpen}
        onClose={() => setSaveTemplateOpen(false)}
      />
    ) : null}
    </>
  );
}
