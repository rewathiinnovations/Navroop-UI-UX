'use client';

import Link from 'next/link';
import { useState, type MouseEvent } from 'react';
import { Copy, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { formatRelativeTime } from '@/lib/format-relative-time';
import {
  initialsGradient,
  isProjectGenerating,
  projectInitials,
  type ListProject,
} from '@/lib/projects/list-client';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/shadcn/dropdown-menu';
import { cn } from '@/utils/cn';
import styles from './project-card.module.css';
import { fetchJson, notify, toMessage } from '@/lib/notify';

function publishBadgeFor(project: ListProject) {
  if (project.publishBadge) return project.publishBadge;
  if (project.liveUrl || project.status === 'published') return 'live' as const;
  if (project.previewUrl || project.status === 'preview') return 'preview' as const;
  return 'draft' as const;
}

function PublishBadge({ project }: { project: ListProject }) {
  const kind = publishBadgeFor(project);
  const url = kind === 'live' ? project.liveUrl : kind === 'preview' ? project.previewUrl : null;
  const label = kind === 'live' ? 'Live' : kind === 'preview' ? 'Preview' : 'Draft';
  return (
    <span
      title={url || label}
      className={cn(
        'absolute left-8 top-8 z-10 rounded-full px-8 py-3 text-[11px] font-medium',
        kind === 'live' && 'bg-emerald-600 text-white',
        kind === 'preview' && 'bg-sky-600 text-white',
        kind === 'draft' && 'bg-zinc-500/90 text-white',
      )}
    >
      {label}
    </span>
  );
}

type ProjectCardProps = {
  project: ListProject;
  density?: 'grid' | 'list';
  onRenamed?: (id: string, name: string) => void;
  onDuplicated?: (project: ListProject) => void;
  onDeleted?: (id: string) => void;
};

export default function ProjectCard({
  project,
  density = 'grid',
  onRenamed,
  onDuplicated,
  onDeleted,
}: ProjectCardProps) {
  const generating = isProjectGenerating(project);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(project.name);
  const [busy, setBusy] = useState(false);

  const href = `/project/${project.id}`;
  const ownerName = project.owner?.name?.trim() || 'Member';
  const edited = project.updatedAt ? `Edited ${formatRelativeTime(project.updatedAt)}` : '';

  const stop = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  // These three used to drop failures on the floor: the card simply stayed as
  // it was, which reads exactly like a no-op rename or a refused delete.
  const rename = async () => {
    const name = renameValue.trim();
    setRenaming(false);
    if (!name || name === project.name) return;
    setBusy(true);
    try {
      await fetchJson(`/api/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      onRenamed?.(project.id, name);
      notify.success(`Renamed to “${name}”.`, { key: `project-${project.id}` });
    } catch (cause) {
      setRenameValue(project.name);
      notify.error(cause, {
        fallback: 'Could not rename the project',
        key: `project-${project.id}`,
      });
    } finally {
      setBusy(false);
    }
  };

  const duplicate = async () => {
    setMenuOpen(false);
    setBusy(true);
    const toastId = notify.loading('Duplicating project…');
    try {
      const data = await fetchJson<{ project?: ListProject }>(
        `/api/projects/${project.id}/duplicate`,
        { method: 'POST' },
      );
      if (!data.project) {
        notify.settle(toastId, 'error', 'Could not duplicate the project');
        return;
      }
      onDuplicated?.(data.project);
      notify.settle(toastId, 'success', `“${data.project.name}” created.`);
    } catch (cause) {
      notify.settle(toastId, 'error', toMessage(cause, 'Could not duplicate the project'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setMenuOpen(false);
    if (!confirm('Delete this project? It will be permanently deleted after 30 days.')) return;
    setBusy(true);
    try {
      await fetchJson(`/api/projects/${project.id}`, { method: 'DELETE' });
      onDeleted?.(project.id);
      notify.success(`“${project.name}” deleted — recoverable for 30 days.`, {
        key: `project-${project.id}`,
      });
    } catch (cause) {
      notify.error(cause, {
        fallback: 'Could not delete the project',
        key: `project-${project.id}`,
      });
    } finally {
      setBusy(false);
    }
  };

  const thumb = (
    <div
      className={cn(
        'relative overflow-hidden',
        density === 'grid' ? 'aspect-[16/10] rounded-t-12' : 'h-72 w-112 shrink-0 rounded-l-12',
      )}
    >
      <PublishBadge project={project} />
      {generating ? (
        <div
          className={cn(
            'flex h-full w-full flex-col items-center justify-center px-16 text-center text-white',
            styles.generating,
          )}
        >
          {density === 'grid' ? (
            <>
              <p className="text-[16px] font-medium">Big things loading</p>
              <p className="mt-6 text-[13px] text-white/85">Your idea is taking shape.</p>
            </>
          ) : null}
        </div>
      ) : project.thumbnailUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={project.thumbnailUrl} alt="" className="h-full w-full object-cover object-top" />
      ) : (
        <div
          className="flex h-full w-full items-center justify-center text-[22px] font-medium text-white"
          style={{ background: initialsGradient(project.name || project.id) }}
        >
          {projectInitials(project.name || 'P')}
        </div>
      )}
    </div>
  );

  const meta =
    generating && density === 'list' ? (
      <div className="flex min-w-0 flex-1 flex-col justify-center px-16 pr-44">
        <p className="text-[15px] font-medium text-[var(--studio-fg)]">Big things loading</p>
        <p className="mt-4 text-[13px] text-[var(--studio-muted)]">Your idea is taking shape.</p>
      </div>
    ) : !generating ? (
      <div className={cn(density === 'grid' ? 'p-16 pr-44' : 'min-w-0 flex-1 py-8 pr-44')}>
        {renaming ? (
          <input
            value={renameValue}
            onClick={stop}
            onChange={(event) => setRenameValue(event.target.value)}
            onBlur={() => void rename()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void rename();
              }
              if (event.key === 'Escape') setRenaming(false);
            }}
            className="w-full rounded-8 border border-[var(--studio-line)] px-8 py-4 text-[15px] font-medium text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
            autoFocus
          />
        ) : (
          <h2 className="truncate text-[15px] font-medium text-[var(--studio-fg)]">
            {project.name}
          </h2>
        )}
        <div className="mt-6 flex items-center gap-8">
          {project.owner?.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={project.owner.avatarUrl}
              alt=""
              className="size-20 rounded-full object-cover"
            />
          ) : (
            <span
              aria-hidden
              className="inline-flex size-20 items-center justify-center rounded-full bg-[var(--studio-skeleton)] text-[9px] font-medium text-[var(--studio-muted)]"
            >
              {projectInitials(ownerName)}
            </span>
          )}
          <p className="truncate text-[13px] text-[var(--studio-muted)]">{edited}</p>
        </div>
      </div>
    ) : null;

  const menuItemClass =
    'flex min-h-[40px] cursor-pointer items-center gap-8 rounded-none px-12 text-[13px] text-[var(--studio-fg)] focus:bg-[var(--studio-surface-hover)] focus:text-[var(--studio-fg)]';

  const kebab = (
    <div
      className={cn(
        'absolute z-10 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100',
        density === 'grid' ? 'right-8 top-[calc(100%-52px)]' : 'right-8 top-1/2 -translate-y-1/2',
        menuOpen && 'opacity-100',
      )}
    >
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`More actions for ${project.name}`}
            disabled={busy}
            onClick={(event) => event.stopPropagation()}
            className="inline-flex size-[36px] items-center justify-center rounded-8 text-[var(--studio-muted)] hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)] transition-colors duration-200"
          >
            <MoreHorizontal className="size-16" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={4}
          collisionPadding={8}
          className="z-50 w-168 rounded-10 border-[var(--studio-line)] bg-[var(--studio-surface)] p-0 text-[var(--studio-fg)] shadow-[0_12px_24px_rgba(24,24,27,0.12)]"
        >
          <DropdownMenuItem asChild className={menuItemClass}>
            <Link href={href}>Open</Link>
          </DropdownMenuItem>
          <DropdownMenuItem
            className={menuItemClass}
            onSelect={() => {
              setRenameValue(project.name);
              setRenaming(true);
            }}
          >
            <Pencil className="size-14" aria-hidden />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem className={menuItemClass} onSelect={() => void duplicate()}>
            <Copy className="size-14" aria-hidden />
            Duplicate
          </DropdownMenuItem>
          <DropdownMenuItem
            className={cn(
              menuItemClass,
              'text-[var(--studio-danger)] focus:text-[var(--studio-danger)]',
            )}
            onSelect={() => void remove()}
          >
            <Trash2 className="size-14" aria-hidden />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  return (
    <article
      className={cn(
        'studio-motion group relative overflow-visible rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] shadow-[0_4px_16px_rgba(24,24,27,0.04)] transition-[transform,border-color] duration-200 hover:border-[var(--studio-line-strong)]',
        density === 'grid' && 'hover:-translate-y-2',
        density === 'list' && 'flex items-stretch',
      )}
    >
      <Link
        href={href}
        className={cn(
          'block cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--studio-ring)]',
          density === 'list' && 'flex min-w-0 flex-1 items-stretch',
        )}
      >
        {thumb}
        {meta}
      </Link>
      {renaming && generating && (
        <div className="border-t border-[var(--studio-line)] p-12">
          <input
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onBlur={() => void rename()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void rename();
              }
              if (event.key === 'Escape') setRenaming(false);
            }}
            className="w-full rounded-8 border border-[var(--studio-line)] px-8 py-4 text-[15px] font-medium text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
            autoFocus
          />
        </div>
      )}
      {kebab}
    </article>
  );
}
