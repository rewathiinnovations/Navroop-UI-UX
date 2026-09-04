'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Check,
  Download,
  FileText,
  Github,
  History,
  Loader2,
  ChevronDown,
  ExternalLink,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  MoreHorizontal,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/shadcn/dropdown-menu';
import SaveAsTemplateDialog from '@/components/templates/SaveAsTemplateDialog';
import { downloadProjectZip, formatExportBytes } from '@/lib/export/client';
import { cn } from '@/utils/cn';
import { pushProjectToGitHub } from '@/lib/github/actions';
import { formatRelativeTime } from '@/lib/format-relative-time';
import Hint from './Hint';
import PreviewDeviceToolbar from './PreviewDeviceToolbar';
import PublishPanel from './PublishPanel';
import {
  formatPreviewSize,
  getPreviewDevice,
  openPreviewWindow,
  PREVIEW_NEW_TAB_REQUIRES_ORIGIN,
  rotateDeviceSize,
  type PreviewDeviceKey,
} from '@/lib/preview/devices';
import { useDisclosurePopover } from '@/hooks/useDisclosurePopover';
import { type Checkpoint, type SaveStatus, type WorkspacePage, type WorkspaceView } from './types';
import PresenceAvatars from './PresenceAvatars';
import type { PresenceViewer } from './useProjectPresence';
import {
  VersionMenu,
  WORKSPACE_MENU_ITEM,
  WorkspaceToolMenu,
  WorkspaceViewSwitch,
} from './WorkspaceViewControls';

const ICON_BTN =
  'studio-icon-hit inline-flex shrink-0 items-center justify-center rounded-full text-[var(--studio-muted)] transition-colors duration-150 hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)] disabled:cursor-not-allowed disabled:opacity-40';

function BarDivider() {
  return <span className="mx-2 h-16 w-px shrink-0 bg-[var(--studio-line)]" aria-hidden />;
}

function NavroopMark() {
  return (
    <Link
      href="/dashboard"
      aria-label="Navroop dashboard"
      className="studio-icon-hit inline-flex shrink-0 items-center justify-center rounded-10 transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
    >
      <svg viewBox="0 0 32 32" className="size-22" fill="none" aria-hidden>
        <defs>
          <linearGradient
            id="navroopWorkspaceMark"
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
          fill="url(#navroopWorkspaceMark)"
        />
      </svg>
    </Link>
  );
}

export function saveLabel(
  saveState: SaveStatus,
  updatedAt: string | null,
  hasStoredFiles: boolean,
  filesKnown: boolean,
) {
  if (saveState === 'saving') return 'Saving…';
  if (saveState === 'saved') return 'All changes saved';
  if (saveState === 'signin') return 'Sign in to save';
  // `updatedAt` is `Project.updatedAt`, which moves on any write to the row —
  // a phase change, a lock, a job abandoned at server restart — not just a
  // save. Without `hasStoredFiles` this claimed "Last saved" for a project
  // that had never saved anything (F-brief Task 3).
  //
  // `hasStoredFiles` alone isn't enough either: it starts `false` before the
  // files fetch resolves and stays `false` forever if that fetch fails, so
  // gating on it directly would hide the label for projects that genuinely
  // have content, for as long as the fetch is pending or errors. `filesKnown`
  // (true only once the files fetch has resolved successfully) tells us
  // whether `hasStoredFiles` is trustworthy; while it's false, fall back to
  // the pre-Task-3 behaviour of trusting `updatedAt` alone.
  if (updatedAt && (hasStoredFiles || !filesKnown))
    return `Last saved ${formatRelativeTime(updatedAt)}`;
  return null;
}

export default function WorkspaceTopBar({
  projectName,
  saveState,
  updatedAt,
  hasStoredFiles,
  filesKnown,
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
  previewOriginConfigured = true,
  previewDevice = 'desktop',
  previewRotated = false,
  onPreviewDeviceChange,
  onTogglePreviewRotate,
  projectId,
  githubConnected = false,
  githubRepoUrl = null,
  sourceUrl = null,
  presenceViewers = [],
  checkpoints = [],
  activeVersionId = null,
  onPreviewVersion,
}: {
  projectName: string;
  saveState: SaveStatus;
  updatedAt: string | null;
  /** Whether the project has any stored files — see `ProjectWorkspace`'s `hasStoredFiles`. */
  hasStoredFiles: boolean;
  /** Whether `hasStoredFiles` is trustworthy yet — false while the files fetch is loading or has errored. */
  filesKnown: boolean;
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
  previewOriginConfigured?: boolean;
  previewDevice?: PreviewDeviceKey;
  previewRotated?: boolean;
  onPreviewDeviceChange?: (key: PreviewDeviceKey) => void;
  onTogglePreviewRotate?: () => void;
  projectId?: string | null;
  githubConnected?: boolean;
  githubRepoUrl?: string | null;
  sourceUrl?: string | null;
  presenceViewers?: PresenceViewer[];
  /** Newest-first, straight from `useCheckpoints`; the pills show the last few. */
  checkpoints?: Checkpoint[];
  /** The checkpoint currently being previewed, so its pill reads as selected. */
  activeVersionId?: string | null;
  onPreviewVersion?: (id: string) => void;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(projectName);
  const nameFieldRef = useRef<HTMLInputElement>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pushSuccess, setPushSuccess] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [repoUrl, setRepoUrl] = useState(githubRepoUrl);
  const [moreOpen, setMoreOpen] = useState(false);
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportHint, setExportHint] = useState<string | null>(null);
  const [compactPreview, setCompactPreview] = useState(false);
  const [compactActions, setCompactActions] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  /**
   * A paragraph plus one link, not a command list, so this is a disclosure rather
   * than a menu (the two menus beside it are Radix `DropdownMenu`s). The
   * hand-rolled `mousedown` + Escape listener it replaces never moved focus into
   * the panel, returned focus to `<body>` on Escape, and left the panel open when
   * the reader tabbed past it (N-024).
   */
  const connectPanelId = useId();
  const {
    rootRef: connectRef,
    panelRef: connectPanelRef,
    triggerRef: connectTriggerRef,
    onBlurCapture: onConnectBlurCapture,
  } = useDisclosurePopover({ open: connectOpen, onClose: () => setConnectOpen(false) });

  useEffect(() => {
    setRepoUrl(githubRepoUrl);
  }, [githubRepoUrl]);

  useEffect(() => {
    const node = headerRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      setCompactPreview(entry.contentRect.width < 1180);
      setCompactActions(entry.contentRect.width < 900);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    // Generation renames the project from the prompt, so `projectName` can change under a
    // reader who is part-way through typing a new one — and this effect would replace what
    // they had typed. While the field has focus their text is the newer of the two, and
    // `commit` writes it on blur; the server value is picked up the next time it changes.
    if (nameFieldRef.current && document.activeElement === nameFieldRef.current) return;
    setDraft(projectName);
  }, [projectName]);

  const commit = () => {
    const next = draft.trim() || 'Untitled project';
    setDraft(next);
    if (next !== projectName) onRename(next);
  };

  const status = saveLabel(saveState, updatedAt, hasStoredFiles, filesKnown);

  return (
    <>
      <header
        ref={headerRef}
        className="relative z-30 flex min-h-56 shrink-0 flex-wrap items-center gap-8 overflow-visible border-b border-[var(--studio-line)] bg-[var(--studio-header-bg)] px-10 py-4 backdrop-blur-xl"
      >
        <div className="flex shrink-0 items-center gap-6">
          <NavroopMark />
          <div className="flex min-w-0 flex-col justify-center">
            <input
              ref={nameFieldRef}
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
                  <Link
                    href="/?auth=login&next=/dashboard"
                    className="text-[var(--studio-accent)] hover:underline"
                  >
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
              {sourceUrl.replace(/^https?:\/\//i, '')}
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
              {chatCollapsed ? (
                <PanelLeftOpen className="size-16" />
              ) : (
                <PanelLeftClose className="size-16" />
              )}
            </button>
          </Hint>
        </div>

        {/* Primary cluster order: Preview|Code → page switcher → device → version → more views. Each control is shrink-0; the header wraps the cluster instead of letting icons overlap. */}
        <div className="flex max-w-full shrink-0 flex-wrap items-center gap-6">
          <WorkspaceViewSwitch view={view} onViewChange={onViewChange} />
          <div
            className={cn(
              'relative shrink-0 items-center',
              compactPreview && projectId ? 'hidden' : 'flex',
            )}
          >
            <FileText
              className="pointer-events-none absolute left-10 size-13 text-[var(--studio-muted)]"
              aria-hidden
            />
            <label className="sr-only" htmlFor="workspace-page">
              Page
            </label>
            <select
              id="workspace-page"
              value={selectedPage}
              onChange={(event) => onSelectPage(event.target.value)}
              className="h-44 max-w-[148px] shrink-0 appearance-none rounded-full border border-[var(--studio-line)] bg-[var(--studio-surface)] py-0 pr-28 pl-28 text-[12px] font-medium text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
            >
              {pages.map((page) => (
                <option key={page.path} value={page.path}>
                  {page.label}
                </option>
              ))}
            </select>
            <ChevronDown
              className="pointer-events-none absolute right-10 size-13 text-[var(--studio-muted)]"
              aria-hidden
            />
          </div>
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
          {onPreviewVersion ? (
            <VersionMenu
              checkpoints={checkpoints}
              activeId={activeVersionId}
              onPreview={onPreviewVersion}
            />
          ) : null}
          <WorkspaceToolMenu
            view={view}
            onViewChange={onViewChange}
            open={toolsOpen}
            onOpenChange={setToolsOpen}
          />
        </div>

        <div className="ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-6">
          <PresenceAvatars viewers={presenceViewers} />
          {/*
           * There was a "Live mode" switch here. Live mode died with the sandbox
           * subsystem (migration 20260819010000_drop_sandbox_columns) and
           * `useLivePreviewMode` is now an inert predicate that reports
           * `enabled: false` unconditionally, so the switch had nothing to turn
           * on: ProjectWorkspace (the only render site of this bar) never passed
           * `onToggleLiveMode`, which the switch was gated on, so it could not
           * render either. Do not re-add it — there is no live preview to reach.
           */}
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
          <div className="inline-flex items-center">
            <Hint
              label={previewOriginConfigured ? 'Open in new tab' : PREVIEW_NEW_TAB_REQUIRES_ORIGIN}
            >
              <button
                type="button"
                disabled={!previewUrl || !previewOriginConfigured}
                title={previewOriginConfigured ? undefined : PREVIEW_NEW_TAB_REQUIRES_ORIGIN}
                onClick={() => previewUrl && projectId && openPreviewWindow(previewUrl, projectId)}
                aria-label="Open in new tab"
                className={ICON_BTN}
              >
                <ExternalLink className="size-15" />
              </button>
            </Hint>
          </div>
          <div
            className="relative flex flex-col items-end"
            ref={connectRef}
            onBlurCapture={onConnectBlurCapture}
          >
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
                  ref={connectTriggerRef}
                  type="button"
                  aria-expanded={connectOpen}
                  aria-controls={connectPanelId}
                  aria-label="Push to GitHub"
                  onClick={() => setConnectOpen((open) => !open)}
                  className={ICON_BTN}
                >
                  <Github className="size-16" />
                </button>
              )}
            </div>
            {pushError && (
              <p
                className="absolute top-full right-0 z-30 mt-4 max-w-[240px] text-right text-[11px] leading-4 text-[var(--studio-danger)]"
                role="alert"
              >
                {pushError}
              </p>
            )}
            {!githubConnected && connectOpen && (
              <div
                ref={connectPanelRef}
                id={connectPanelId}
                role="group"
                aria-label="Push to GitHub"
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
            /* The other hand-rolled `role="menu"` from N-016. The page list is a
               single-select group, so it is a radio group rather than four
               commands that happen to look selected. */
            <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
              <DropdownMenuTrigger asChild>
                <button type="button" aria-label="Project actions" className={ICON_BTN}>
                  <MoreHorizontal className="size-16" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                sideOffset={6}
                collisionPadding={8}
                aria-label="Project actions"
                className="studio-portal z-40 w-[200px] rounded-12 border-[var(--studio-line)] bg-[var(--studio-surface)] p-4 text-[var(--studio-fg)] shadow-sm"
              >
                {compactPreview ? (
                  <>
                    <DropdownMenuRadioGroup value={selectedPage} onValueChange={onSelectPage}>
                      {pages.map((page) => (
                        <DropdownMenuRadioItem
                          key={page.path}
                          value={page.path}
                          className={cn(
                            WORKSPACE_MENU_ITEM,
                            selectedPage === page.path
                              ? 'font-medium text-[var(--studio-fg)]'
                              : 'text-[var(--studio-muted)]',
                          )}
                        >
                          {page.label}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                    <DropdownMenuSeparator className="my-4 bg-[var(--studio-line)]" />
                  </>
                ) : null}
                {repoUrl ? (
                  <DropdownMenuItem asChild className={WORKSPACE_MENU_ITEM}>
                    <a href={repoUrl} target="_blank" rel="noreferrer">
                      View on GitHub
                    </a>
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  className={WORKSPACE_MENU_ITEM}
                  onSelect={() => setSaveTemplateOpen(true)}
                >
                  Save as template
                </DropdownMenuItem>
                {/* Below 900px the Share button beside this menu is hidden, so without
                    this item Share has no keyboard or pointer route at all. */}
                {compactActions ? (
                  <>
                    <DropdownMenuSeparator className="my-4 bg-[var(--studio-line)]" />
                    <DropdownMenuItem className={WORKSPACE_MENU_ITEM} onSelect={() => onShare?.()}>
                      Share
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <BarDivider />
          <Hint label={exporting ? 'Downloading…' : 'Download code'}>
            <button
              type="button"
              disabled={exporting || !projectId}
              onClick={() => {
                if (!projectId || exporting) return;
                setExporting(true);
                setExportHint(null);
                void downloadProjectZip(projectId).then((result) => {
                  setExporting(false);
                  setExportHint(result.ok ? formatExportBytes(result.bytes) : result.error);
                });
              }}
              aria-label="Download code"
              className={ICON_BTN}
            >
              {exporting ? (
                <Loader2 className="size-15 animate-spin" />
              ) : (
                <Download className="size-15" />
              )}
            </button>
          </Hint>
          {exportHint ? (
            <span className="text-[11px] text-[var(--studio-faint)]">{exportHint}</span>
          ) : null}
          {!compactActions ? (
            <button
              type="button"
              onClick={onShare}
              className="inline-flex h-44 shrink-0 items-center whitespace-nowrap rounded-full border border-[var(--studio-line-strong)] px-14 text-[13px] font-medium text-[var(--studio-fg)] transition-colors duration-150 hover:bg-[var(--studio-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
            >
              Share
            </button>
          ) : null}
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
