'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Brain,
  ChevronDown,
  Code2,
  Eye,
  Images,
  Link2,
  Search,
  SlidersHorizontal,
} from 'lucide-react';
import { cn } from '@/utils/cn';
import { relativeTime } from '@/lib/projects/prompt';
import Hint from './Hint';
import {
  WORKSPACE_PRIMARY_TABS,
  WORKSPACE_TOOL_TABS,
  type Checkpoint,
  type WorkspaceView,
} from './types';

/**
 * The header's view controls. They live outside `WorkspaceTopBar` because that file
 * imports the `'use server'` GitHub action, so importing it from a test pulls prisma
 * and the auth stack in with it; everything here is presentation over props, so a
 * test can render it on its own.
 */

/** One icon per view, shared by the primary switch and the overflow menu. */
const VIEW_ICONS: Record<WorkspaceView, typeof Eye> = {
  preview: Eye,
  code: Code2,
  seo: Search,
  assets: Images,
  brain: Brain,
  domains: Link2,
};

/**
 * Quality/Assets/Brain/Domains, behind one trigger. `open` is controlled by the
 * caller so the menu can be rendered — and asserted on — without a DOM to click in;
 * the outside-click and Escape handlers live here because they belong to the menu,
 * and they report the close upwards rather than keeping a second copy of the state.
 *
 * The trigger takes the active view's name when one of these four is showing.
 * Without that, choosing Quality left the header with nothing selected while a
 * Quality panel filled the pane.
 */
export function WorkspaceToolMenu({
  view,
  onViewChange,
  open,
  onOpenChange,
}: {
  view: WorkspaceView;
  onViewChange: (view: WorkspaceView) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [onOpenChange, open]);

  const activeTool = WORKSPACE_TOOL_TABS.find((tab) => tab.id === view) ?? null;
  const TriggerIcon = activeTool ? VIEW_ICONS[activeTool.id] : SlidersHorizontal;

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={activeTool ? `${activeTool.label} — more views` : 'More views'}
        onClick={() => onOpenChange(!open)}
        className={cn(
          'inline-flex min-h-[44px] items-center gap-4 rounded-full px-10 text-[12px] font-medium transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]',
          activeTool
            ? 'bg-[var(--studio-surface)] text-[var(--studio-fg)] shadow-sm'
            : 'text-[var(--studio-muted)] hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)]',
        )}
      >
        <TriggerIcon className="size-15" aria-hidden />
        <span className="hidden lg:inline">{activeTool ? activeTool.label : 'More'}</span>
        <ChevronDown className="size-12" aria-hidden />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="More views"
          className="absolute top-full left-0 z-40 mt-6 w-[176px] rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] p-4 shadow-sm"
        >
          {WORKSPACE_TOOL_TABS.map((tab) => {
            const Icon = VIEW_ICONS[tab.id];
            const selected = view === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => {
                  onViewChange(tab.id);
                  onOpenChange(false);
                }}
                className={cn(
                  'flex w-full items-center gap-8 rounded-8 px-10 py-8 text-left text-[12px]',
                  'hover:bg-[var(--studio-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]',
                  selected
                    ? 'font-medium text-[var(--studio-fg)]'
                    : 'text-[var(--studio-muted)] hover:text-[var(--studio-fg)]',
                )}
              >
                <Icon className="size-14" aria-hidden />
                {tab.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Preview/Code as the primary switch. Those two are what a reader touches every few
 * seconds; the other four used to sit beside them as an icon row, so six controls
 * competed for the same attention and neither pair read as primary.
 */
export function WorkspaceViewSwitch({
  view,
  onViewChange,
}: {
  view: WorkspaceView;
  onViewChange: (view: WorkspaceView) => void;
}) {
  const [toolsOpen, setToolsOpen] = useState(false);

  return (
    <div className="flex items-center gap-6">
      <div
        role="tablist"
        aria-label="Workspace view"
        data-primary-switch
        className="inline-flex min-h-[44px] items-center rounded-full border border-[var(--studio-line-strong)] bg-[var(--studio-bg)] p-3 shadow-sm"
      >
        {WORKSPACE_PRIMARY_TABS.map((tab) => {
          const Icon = VIEW_ICONS[tab.id];
          const selected = view === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              data-view={tab.id}
              onClick={() => onViewChange(tab.id)}
              className={cn(
                'inline-flex min-h-[36px] items-center gap-6 rounded-full px-16 text-[13px] font-semibold transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]',
                selected
                  ? 'bg-[var(--studio-surface)] text-[var(--studio-fg)] shadow-sm'
                  : 'text-[var(--studio-muted)] hover:text-[var(--studio-fg)]',
              )}
            >
              <Icon className="size-14" aria-hidden />
              {tab.label}
            </button>
          );
        })}
      </div>
      <WorkspaceToolMenu
        view={view}
        onViewChange={onViewChange}
        open={toolsOpen}
        onOpenChange={setToolsOpen}
      />
    </div>
  );
}

/** How many version pills the header shows. The rest stay in `VersionHistoryPanel`. */
export const VERSION_PILL_LIMIT = 5;

export type VersionPill = {
  id: string;
  /** 1-based, counted over the whole list, so v3 means the third checkpoint ever. */
  version: number;
  label: string;
  detail: string;
  pruned: boolean;
};

/**
 * `getCheckpoints` orders by `createdAt desc` and takes no limit — thinning removes
 * snapshots, never rows — so a long-lived project hands the header dozens of them.
 * The newest `limit` are returned oldest-first, which is the order pills read in, and
 * the version number is counted over the full list so v7 does not become v5 the day
 * an eighth checkpoint pushes it off the row.
 */
export function versionPillList(
  checkpoints: Checkpoint[],
  limit: number = VERSION_PILL_LIMIT,
): VersionPill[] {
  const total = checkpoints.length;
  return checkpoints
    .slice(0, Math.max(limit, 0))
    .map((checkpoint, index) => ({
      id: checkpoint.id,
      version: total - index,
      label: `v${total - index}`,
      detail: `${checkpoint.label} · ${relativeTime(checkpoint.createdAt)}`,
      pruned: Boolean(checkpoint.snapshotPruned),
    }))
    .reverse();
}

/**
 * A shortcut to the last few versions. Clicking one runs the same preview call the
 * chat's "view this version" button and the history panel restore path already use —
 * a thinned checkpoint has no snapshot to preview, and the server answers those with
 * a pruned error, so the pill says so instead of offering a click that cannot work.
 */
export function VersionPills({
  checkpoints,
  activeId = null,
  onPreview,
  limit = VERSION_PILL_LIMIT,
  className,
}: {
  checkpoints: Checkpoint[];
  activeId?: string | null;
  onPreview: (id: string) => void;
  limit?: number;
  className?: string;
}) {
  const pills = versionPillList(checkpoints, limit);
  if (pills.length === 0) return null;

  return (
    <div
      role="group"
      aria-label="Project versions"
      className={cn('flex items-center gap-3', className)}
    >
      {pills.map((pill) => (
        <Hint
          key={pill.id}
          label={
            pill.pruned ? `${pill.label} — snapshot removed` : `${pill.label} · ${pill.detail}`
          }
        >
          <button
            type="button"
            disabled={pill.pruned}
            aria-pressed={pill.id === activeId}
            aria-label={
              pill.pruned
                ? `${pill.label} — snapshot removed, cannot preview`
                : `Preview ${pill.label}`
            }
            data-version={pill.version}
            onClick={() => onPreview(pill.id)}
            className={cn(
              'inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full border px-8 text-[11px] font-medium tabular-nums transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]',
              'disabled:cursor-not-allowed disabled:opacity-40',
              pill.id === activeId
                ? 'border-[var(--studio-line-strong)] bg-[var(--studio-surface)] text-[var(--studio-fg)] shadow-sm'
                : 'border-[var(--studio-line)] text-[var(--studio-muted)] hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)]',
            )}
          >
            {pill.label}
          </button>
        </Hint>
      ))}
    </div>
  );
}
