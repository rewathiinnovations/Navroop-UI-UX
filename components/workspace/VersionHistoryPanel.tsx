'use client';

import { X } from 'lucide-react';
import { relativeTime } from '@/lib/projects/prompt';
import type { Checkpoint } from './types';

export default function VersionHistoryPanel({
  open,
  onClose,
  checkpoints = [],
  onRestore,
}: {
  open: boolean;
  onClose: () => void;
  checkpoints?: Checkpoint[];
  onRestore?: (id: string) => void;
}) {
  if (!open) return null;

  return (
    <div className="absolute inset-y-0 right-0 z-40 flex">
      <button
        type="button"
        aria-label="Close version history"
        className="h-full w-full cursor-default bg-black/20 sm:w-auto sm:flex-1"
        onClick={onClose}
      />
      <aside
        className="flex h-full w-[320px] flex-col border-l border-[var(--studio-line)] bg-[var(--studio-surface)] shadow-[-12px_0_40px_rgba(24,24,27,0.08)]"
        role="dialog"
        aria-label="Version history"
      >
        <div className="flex items-center justify-between border-b border-[var(--studio-line)] px-16 py-12">
          <div>
            <h2 className="text-[14px] font-semibold text-[var(--studio-fg)]">Version history</h2>
            <p className="text-[12px] text-[var(--studio-faint)]">Restore creates a new version</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex size-36 items-center justify-center rounded-10 text-[var(--studio-muted)] hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)]"
          >
            <X className="size-16" />
          </button>
        </div>
        <ul className="flex-1 overflow-y-auto p-12">
          {checkpoints.length === 0 && (
            <li className="px-4 py-16 text-center text-[13px] text-[var(--studio-faint)]">
              No versions yet
            </li>
          )}
          {checkpoints.map((checkpoint) => (
            <li
              key={checkpoint.id}
              className="mb-8 rounded-12 border border-[var(--studio-line)] p-12"
            >
              <div className="mb-10 h-72 overflow-hidden rounded-8 bg-[var(--studio-skeleton)]">
                {checkpoint.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={checkpoint.thumbnailUrl} alt="" className="size-full object-cover" />
                ) : (
                  <div className="flex size-full items-center justify-center bg-gradient-to-br from-zinc-100 to-zinc-200 text-[11px] text-[var(--studio-faint)] dark:from-zinc-800 dark:to-zinc-900">
                    {checkpoint.label}
                  </div>
                )}
              </div>
              <p className="text-[13px] font-medium text-[var(--studio-fg)]">{checkpoint.label}</p>
              <p className="mb-10 text-[11px] text-[var(--studio-faint)]">{relativeTime(checkpoint.createdAt)}</p>
              <button
                type="button"
                onClick={() => onRestore?.(checkpoint.id)}
                className="inline-flex min-h-[36px] items-center rounded-full border border-[var(--studio-line-strong)] px-12 text-[12px] font-medium text-[var(--studio-fg)] hover:bg-[var(--studio-surface-hover)]"
              >
                Restore
              </button>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
