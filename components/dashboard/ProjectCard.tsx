"use client";

import Link from "next/link";
import { useEffect, useState, type MouseEvent } from "react";
import { Copy, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { formatRelativeTime } from "@/lib/format-relative-time";
import {
  initialsGradient,
  isProjectGenerating,
  projectInitials,
  type ListProject,
} from "@/lib/projects/list-client";
import { cn } from "@/utils/cn";
import styles from "./project-card.module.css";

type ProjectCardProps = {
  project: ListProject;
  density?: "grid" | "list";
  onRenamed?: (id: string, name: string) => void;
  onDuplicated?: (project: ListProject) => void;
  onDeleted?: (id: string) => void;
};

export default function ProjectCard({
  project,
  density = "grid",
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
  const ownerName = project.owner?.name?.trim() || "Member";
  const edited = project.updatedAt ? `Edited ${formatRelativeTime(project.updatedAt)}` : "";

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const stop = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const rename = async () => {
    const name = renameValue.trim();
    setRenaming(false);
    if (!name || name === project.name) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (response.ok) onRenamed?.(project.id, name);
    } finally {
      setBusy(false);
    }
  };

  const duplicate = async () => {
    setMenuOpen(false);
    setBusy(true);
    try {
      const response = await fetch(`/api/projects/${project.id}/duplicate`, { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.project) onDuplicated?.(data.project as ListProject);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setMenuOpen(false);
    if (!confirm("Delete this project? 30 din baad apne aap hamesha ke liye delete ho jayega.")) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/projects/${project.id}`, { method: "DELETE" });
      if (response.ok) onDeleted?.(project.id);
    } finally {
      setBusy(false);
    }
  };

  const thumb = (
    <div
      className={cn(
        "relative overflow-hidden",
        density === "grid" ? "aspect-[16/10]" : "h-72 w-112 shrink-0",
      )}
    >
      {generating ? (
        <div className={cn("flex h-full w-full flex-col items-center justify-center px-16 text-center text-white", styles.generating)}>
          {density === "grid" ? (
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
          {projectInitials(project.name || "P")}
        </div>
      )}
    </div>
  );

  const meta = generating && density === "list" ? (
    <div className="flex min-w-0 flex-1 flex-col justify-center px-16 pr-44">
      <p className="text-[15px] font-medium text-[var(--studio-fg)]">Big things loading</p>
      <p className="mt-4 text-[13px] text-[var(--studio-muted)]">Your idea is taking shape.</p>
    </div>
  ) : !generating ? (
    <div className={cn(density === "grid" ? "p-16 pr-44" : "min-w-0 flex-1 py-8 pr-44")}>
      {renaming ? (
        <input
          value={renameValue}
          onClick={stop}
          onChange={(event) => setRenameValue(event.target.value)}
          onBlur={() => void rename()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void rename();
            }
            if (event.key === "Escape") setRenaming(false);
          }}
          className="w-full rounded-8 border border-[var(--studio-line)] px-8 py-4 text-[15px] font-medium text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
          autoFocus
        />
      ) : (
        <h2 className="truncate text-[15px] font-medium text-[var(--studio-fg)]">{project.name}</h2>
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

  const kebab = (
    <div
      className={cn(
        "absolute z-10 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100",
        density === "grid" ? "right-8 top-[calc(100%-52px)]" : "right-8 top-1/2 -translate-y-1/2",
        menuOpen && "opacity-100",
      )}
    >
      <button
        type="button"
        aria-label={`More actions for ${project.name}`}
        aria-expanded={menuOpen}
        disabled={busy}
        onClick={(event) => {
          stop(event);
          setMenuOpen((open) => !open);
        }}
        className="inline-flex size-[36px] items-center justify-center rounded-8 text-[var(--studio-muted)] hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)] transition-colors duration-200"
      >
        <MoreHorizontal className="size-16" aria-hidden />
      </button>
      {menuOpen && (
        <div
          role="menu"
          onClick={stop}
          className="absolute right-0 z-20 mt-4 w-168 overflow-hidden rounded-10 border border-[var(--studio-line)] bg-[var(--studio-surface)] shadow-[0_12px_24px_rgba(24,24,27,0.12)]"
        >
          <Link
            href={href}
            role="menuitem"
            className="flex min-h-[40px] items-center px-12 text-[13px] text-[var(--studio-fg)] hover:bg-[var(--studio-surface-hover)]"
            onClick={() => setMenuOpen(false)}
          >
            Open
          </Link>
          <button
            type="button"
            role="menuitem"
            className="flex w-full min-h-[40px] items-center gap-8 px-12 text-[13px] text-[var(--studio-fg)] hover:bg-[var(--studio-surface-hover)]"
            onClick={() => {
              setRenameValue(project.name);
              setRenaming(true);
              setMenuOpen(false);
            }}
          >
            <Pencil className="size-14" aria-hidden />
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full min-h-[40px] items-center gap-8 px-12 text-[13px] text-[var(--studio-fg)] hover:bg-[var(--studio-surface-hover)]"
            onClick={() => void duplicate()}
          >
            <Copy className="size-14" aria-hidden />
            Duplicate
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full min-h-[40px] items-center gap-8 px-12 text-[13px] text-[var(--studio-danger)] hover:bg-[var(--studio-surface-hover)]"
            onClick={() => void remove()}
          >
            <Trash2 className="size-14" aria-hidden />
            Delete
          </button>
        </div>
      )}
    </div>
  );

  return (
    <article
      className={cn(
        "studio-motion group relative overflow-hidden rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] shadow-[0_4px_16px_rgba(24,24,27,0.04)] transition-[transform,border-color] duration-200 hover:border-[var(--studio-line-strong)]",
        density === "grid" && "hover:-translate-y-2",
        density === "list" && "flex items-stretch",
      )}
    >
      <Link
        href={href}
        className={cn(
          "block cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--studio-ring)]",
          density === "list" && "flex min-w-0 flex-1 items-stretch",
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
              if (event.key === "Enter") {
                event.preventDefault();
                void rename();
              }
              if (event.key === "Escape") setRenaming(false);
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
