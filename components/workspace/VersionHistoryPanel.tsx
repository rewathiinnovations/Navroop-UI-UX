'use client';

import { useState } from 'react';
import { Loader2, Star, X } from 'lucide-react';
import { relativeTime } from '@/lib/projects/prompt';
import { downloadProjectZip, formatExportBytes } from '@/lib/export/client';
import type { Checkpoint } from './types';
import ConfirmAction from '@/components/admin/ConfirmAction';

export default function VersionHistoryPanel({
  open,
  onClose,
  projectId,
  checkpoints = [],
  onRestore,
  onBookmark,
}: {
  open: boolean;
  onClose: () => void;
  projectId?: string | null;
  checkpoints?: Checkpoint[];
  onRestore?: (id: string) => void;
  onBookmark?: (id: string) => void;
}) {
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [exportHint, setExportHint] = useState<string | null>(null);
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
          {checkpoints.map((checkpoint) => {
            const pruned = Boolean(checkpoint.snapshotPruned);
            return (
              <li
                key={checkpoint.id}
                className={`mb-8 rounded-12 border border-[var(--studio-line)] p-12 ${
                  pruned ? 'opacity-50 grayscale' : ''
                }`}
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
                <div className="mb-4 flex items-start justify-between gap-8">
                  <p className="text-[13px] font-medium text-[var(--studio-fg)]">{checkpoint.label}</p>
                  <button
                    type="button"
                    title="Keep this forever"
                    aria-label="Keep this forever"
                    aria-pressed={Boolean(checkpoint.isBookmarked)}
                    onClick={() => onBookmark?.(checkpoint.id)}
                    className="studio-icon-hit inline-flex shrink-0 items-center justify-center rounded-8 text-[var(--studio-muted)] hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
                  >
                    <Star
                      className="size-14"
                      fill={checkpoint.isBookmarked ? 'currentColor' : 'none'}
                    />
                  </button>
                </div>
                <p className="mb-10 text-[11px] text-[var(--studio-faint)]">{relativeTime(checkpoint.createdAt)}</p>
                {pruned ? (
                  <p className="text-[12px] text-[var(--studio-muted)]">
                    Old checkpoint — cannot restore
                  </p>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-8">
                      <ConfirmAction
                        label="Restore"
                        title="Restore this version?"
                        body="The current sandbox changes to this version. A new checkpoint of the current state is created first, so nothing is lost."
                        confirmLabel="Restore"
                        busyLabel="Restoring…"
                        variant="ghost"
                        triggerClassName="min-h-[36px] rounded-full border border-[var(--studio-line-strong)] px-12 text-[12px] font-medium text-[var(--studio-fg)] hover:bg-[var(--studio-surface-hover)]"
                        onConfirm={() => onRestore?.(checkpoint.id)}
                      />
                      {projectId ? (
                        <button
                          type="button"
                          disabled={exportingId === checkpoint.id}
                          onClick={() => {
                            setExportingId(checkpoint.id);
                            setExportHint(null);
                            void downloadProjectZip(projectId, checkpoint.id).then((result) => {
                              setExportingId(null);
                              if (!result.ok) {
                                setExportHint(result.error);
                                return;
                              }
                              setExportHint(formatExportBytes(result.bytes));
                            });
                          }}
                          className="inline-flex min-h-[36px] items-center gap-6 rounded-full border border-[var(--studio-line-strong)] px-12 text-[12px] font-medium text-[var(--studio-fg)] hover:bg-[var(--studio-surface-hover)] disabled:opacity-50"
                        >
                          {exportingId === checkpoint.id ? <Loader2 className="size-12 animate-spin" /> : null}
                          Download code
                        </button>
                      ) : null}
                    </div>
                    {exportHint ? (
                      <p className="mt-6 text-[11px] text-[var(--studio-faint)]">{exportHint}</p>
                    ) : null}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      </aside>
    </div>
  );
}
