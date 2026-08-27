'use client';

import { useState } from 'react';
import {
  Brain,
  ChevronDown,
  Code2,
  Eye,
  History,
  Images,
  Link2,
  Search,
  SlidersHorizontal,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/shadcn/dropdown-menu';
import { cn } from '@/utils/cn';
import { formatRelativeTime } from '@/lib/format-relative-time';
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
 * The shared row style for every workspace header menu. Radix's stock radio item
 * ships an indicator dot positioned for the rem-based Tailwind scale (this repo
 * runs on px, so `left-2` is 2 px); selection here reads from weight and colour
 * plus the view icon, so the indicator span is hidden rather than left as a
 * 2 px speck in the padding gutter.
 */
export const WORKSPACE_MENU_ITEM = cn(
  'flex w-full cursor-pointer items-center gap-8 rounded-8 px-10 py-8 text-left text-[12px]',
  'outline-none focus:bg-[var(--studio-surface-hover)] focus:text-[var(--studio-fg)]',
  'data-[highlighted]:bg-[var(--studio-surface-hover)] data-[highlighted]:text-[var(--studio-fg)]',
  'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
  '[&>span:first-child]:hidden',
);

/**
 * Quality/Assets/Brain/Domains, behind one trigger, as a real single-select menu.
 *
 * It used to be a hand-rolled `role="menu"` div with `role="menuitemradio"`
 * children: opening it left focus on the trigger, arrows and Home/End did
 * nothing, there was no roving tabIndex, and Escape dropped focus on `<body>`
 * instead of returning it to the trigger — so it announced a keyboard contract
 * it did not implement (N-016, same defect as F-410). Radix owns that contract
 * now, and `DropdownMenuRadioGroup` is what "exactly one of these four views is
 * showing" actually is.
 *
 * `open` stays controlled by the caller so the menu can be rendered — and
 * asserted on — without a DOM to click in.
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
  const activeTool = WORKSPACE_TOOL_TABS.find((tab) => tab.id === view) ?? null;
  const TriggerIcon = activeTool ? VIEW_ICONS[activeTool.id] : SlidersHorizontal;

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={activeTool ? `${activeTool.label} — more views` : 'More views'}
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
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={6}
        collisionPadding={8}
        aria-label="More views"
        className="studio-portal z-40 w-[176px] rounded-12 border-[var(--studio-line)] bg-[var(--studio-surface)] p-4 text-[var(--studio-fg)] shadow-sm"
      >
        <DropdownMenuRadioGroup
          value={view}
          onValueChange={(next) => onViewChange(next as WorkspaceView)}
        >
          {WORKSPACE_TOOL_TABS.map((tab) => {
            const Icon = VIEW_ICONS[tab.id];
            return (
              <DropdownMenuRadioItem
                key={tab.id}
                value={tab.id}
                className={cn(
                  WORKSPACE_MENU_ITEM,
                  view === tab.id
                    ? 'font-medium text-[var(--studio-fg)]'
                    : 'text-[var(--studio-muted)]',
                )}
              >
                <Icon className="size-14" aria-hidden />
                {tab.label}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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
      detail: `${checkpoint.label} · ${formatRelativeTime(checkpoint.createdAt)}`,
      pruned: Boolean(checkpoint.snapshotPruned),
    }))
    .reverse();
}

/**
 * The `vN` label for one checkpoint, counted the same way the pills count: `checkpoints` is
 * newest-first, and v7 means the seventh checkpoint ever, not the seventh from the end. Used
 * for versions outside the newest few, which the pills never show — the preview banner has to
 * be able to name any version the project is parked on after a reload (F-102).
 */
export function versionLabelFor(checkpoints: Checkpoint[], id: string | null): string | null {
  if (!id) return null;
  const index = checkpoints.findIndex((checkpoint) => checkpoint.id === id);
  return index === -1 ? null : `v${checkpoints.length - index}`;
}

/**
 * The version shortcut as a dropdown instead of a row of pills. The pills grew
 * with every checkpoint and pushed the rest of the header off the bar, so the
 * shortcut is one trigger that names the version being previewed and lists the
 * newest few in a menu — the full list still lives in `VersionHistoryPanel`.
 *
 * A thinned checkpoint has no snapshot to preview and the server answers those
 * with a pruned error, so its item is disabled rather than offering a click that
 * can only fail — the behaviour the pills this replaced already had.
 */
export function VersionMenu({
  checkpoints,
  activeId = null,
  onPreview,
}: {
  checkpoints: Checkpoint[];
  activeId?: string | null;
  onPreview: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const pills = versionPillList(checkpoints);
  /**
   * Before the first build there is no version to name, so the whole control goes
   * away rather than offering a trigger reading 'Versions' that opens an empty
   * menu with no items and no empty state — the pills this replaced returned
   * `null` for the same list and the swap dropped that guard.
   */
  if (pills.length === 0) return null;

  const activeLabel = versionLabelFor(checkpoints, activeId);
  /**
   * `activeId` is `Project.previewingCheckpointId`, and null means no old version is
   * being previewed — the pane is showing the live files, which are always the newest
   * checkpoint. That holds in the two states that could plausibly break it: a restore
   * does not roll the files back under an old row, it writes a fresh `restore`-trigger
   * checkpoint that becomes the newest (`restoreCheckpoint`, `lib/checkpoints/actions.ts`)
   * and clears the preview flag; and a build in flight has no checkpoint of its own yet,
   * so the newest one is still the last version that exists to name.
   *
   * `versionPillList` returns its window OLDEST-first (it ends in `.reverse()`), so the
   * newest is the LAST pill. Reading `pills[0]` named the oldest of the window instead:
   * a project with seven checkpoints and nothing being previewed sat under a 'v3' header
   * while v7 filled the pane, and only started telling the truth once the reader picked a
   * version by hand.
   */
  const triggerLabel = activeLabel ?? pills[pills.length - 1].label;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Project versions"
          className={cn(
            'inline-flex min-h-[44px] items-center gap-4 rounded-full border border-[var(--studio-line)] px-10 text-[12px] font-medium tabular-nums transition-colors',
            'text-[var(--studio-muted)] hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]',
          )}
        >
          <History className="size-15" aria-hidden />
          <span className="hidden lg:inline">{triggerLabel}</span>
          <ChevronDown className="size-12" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={6}
        collisionPadding={8}
        aria-label="Project versions"
        className="studio-portal z-40 w-[240px] rounded-12 border-[var(--studio-line)] bg-[var(--studio-surface)] p-4 text-[var(--studio-fg)] shadow-sm"
      >
        <DropdownMenuRadioGroup value={activeId ?? ''} onValueChange={onPreview}>
          {pills.map((pill) => (
            <DropdownMenuRadioItem
              key={pill.id}
              value={pill.id}
              disabled={pill.pruned}
              className={cn(
                WORKSPACE_MENU_ITEM,
                pill.id === activeId
                  ? 'font-medium text-[var(--studio-fg)]'
                  : 'text-[var(--studio-muted)]',
              )}
            >
              <span className="tabular-nums">{pill.label}</span>
              <span className="ml-auto truncate pl-8 text-[var(--studio-faint)]">
                {pill.detail}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
