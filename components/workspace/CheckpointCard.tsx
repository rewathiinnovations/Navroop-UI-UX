'use client';

import { cn } from '@/utils/cn';
import { formatRelativeTime } from '@/lib/format-relative-time';
import ImageWithFallback from './ImageWithFallback';
import type { Checkpoint } from './types';

/**
 * One card, one action. This used to be a segmented control whose "Details" tab
 * rendered nothing — no branch read the segment it set — beside a "Previewing"
 * tab that wrote the checkpoint's files back over the project, and the
 * destructive one was the tab the card mounted on (F-156). Whether this version
 * is the one being previewed is the workspace's state (`previewedVersionId`),
 * not the card's: a card tracking its own would go on claiming it after another
 * card took over.
 */
export default function CheckpointCard({
  checkpoint,
  isPreviewing = false,
  onPreviewCheckpoint,
}: {
  checkpoint: Checkpoint;
  isPreviewing?: boolean;
  onPreviewCheckpoint?: (id: string) => void;
}) {
  /** Shown when there is no thumbnail and when the one there is fails to load (F-129). */
  const thumbnailPlaceholder = (
    <div className="flex size-full items-center justify-center bg-gradient-to-br from-zinc-100 to-zinc-200 dark:from-zinc-800 dark:to-zinc-900">
      <span className="text-[10px] font-medium text-[var(--studio-faint)]">Preview</span>
    </div>
  );

  return (
    <div className="mb-8 overflow-hidden rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)]">
      <div className="flex items-center gap-10 p-10">
        <div className="relative size-44 shrink-0 overflow-hidden rounded-8 bg-[var(--studio-skeleton)]">
          {checkpoint.thumbnailUrl ? (
            <ImageWithFallback
              src={checkpoint.thumbnailUrl}
              alt=""
              className="size-full object-cover"
              width={44}
              height={44}
              fallback={thumbnailPlaceholder}
            />
          ) : (
            thumbnailPlaceholder
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-[var(--studio-fg)]">
            {checkpoint.label}
          </p>
          <p className="text-[11px] text-[var(--studio-faint)]">
            {formatRelativeTime(checkpoint.createdAt)}
          </p>
        </div>
      </div>
      {onPreviewCheckpoint ? (
        <div className="border-t border-[var(--studio-line)] p-4">
          <button
            type="button"
            disabled={isPreviewing}
            aria-current={isPreviewing ? 'true' : undefined}
            onClick={() => onPreviewCheckpoint(checkpoint.id)}
            className={cn(
              'w-full rounded-6 px-8 py-4 text-[11px] font-medium transition-colors',
              isPreviewing
                ? 'bg-[var(--studio-bg)] text-[var(--studio-muted)]'
                : 'text-[var(--studio-fg)] hover:bg-[var(--studio-surface-hover)]',
            )}
          >
            {isPreviewing ? 'Previewing this version' : 'Preview this version'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
