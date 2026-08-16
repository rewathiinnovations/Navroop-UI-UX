'use client';

import { useState } from 'react';
import { cn } from '@/utils/cn';
import { relativeTime } from '@/lib/projects/prompt';
import type { Checkpoint } from './types';

export default function CheckpointCard({
  checkpoint,
  onPreviewCheckpoint,
}: {
  checkpoint: Checkpoint;
  onPreviewCheckpoint?: (id: string) => void;
}) {
  const [segment, setSegment] = useState<'details' | 'previewing'>('previewing');

  return (
    <div className="mb-8 overflow-hidden rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)]">
      <div className="flex items-center gap-10 p-10">
        <div className="relative size-44 shrink-0 overflow-hidden rounded-8 bg-[var(--studio-skeleton)]">
          {checkpoint.thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={checkpoint.thumbnailUrl}
              alt=""
              className="size-full object-cover"
            />
          ) : (
            <div className="flex size-full items-center justify-center bg-gradient-to-br from-zinc-100 to-zinc-200 dark:from-zinc-800 dark:to-zinc-900">
              <span className="text-[10px] font-medium text-[var(--studio-faint)]">Preview</span>
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-[var(--studio-fg)]">{checkpoint.label}</p>
          <p className="text-[11px] text-[var(--studio-faint)]">{relativeTime(checkpoint.createdAt)}</p>
        </div>
      </div>
      <div className="flex border-t border-[var(--studio-line)] p-4">
        <div className="flex w-full rounded-8 bg-[var(--studio-bg)] p-2">
          <button
            type="button"
            onClick={() => setSegment('details')}
            className={cn(
              'flex-1 rounded-6 px-8 py-4 text-[11px] font-medium transition-colors',
              segment === 'details'
                ? 'bg-[var(--studio-surface)] text-[var(--studio-fg)] shadow-sm'
                : 'text-[var(--studio-muted)] hover:text-[var(--studio-fg)]',
            )}
          >
            Details
          </button>
          <button
            type="button"
            onClick={() => {
              setSegment('previewing');
              onPreviewCheckpoint?.(checkpoint.id);
            }}
            className={cn(
              'flex-1 rounded-6 px-8 py-4 text-[11px] font-medium transition-colors',
              segment === 'previewing'
                ? 'bg-[var(--studio-surface)] text-[var(--studio-fg)] shadow-sm'
                : 'text-[var(--studio-muted)] hover:text-[var(--studio-fg)]',
            )}
          >
            Previewing
          </button>
        </div>
      </div>
    </div>
  );
}
