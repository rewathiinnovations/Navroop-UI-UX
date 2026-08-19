'use client';

import { Loader2 } from 'lucide-react';
import {
  summarizeStreamingFiles,
  type StreamingFilesSummary,
} from '@/lib/generation/generation-runtime';
import type { GenerationFile } from '@/lib/generation/types';
import type { PlanTrigger } from './types';

/**
 * The one place the streaming status sentence is written, shared by this
 * indicator and the code panel.
 *
 * Deliberately not "4 of 9 files": `filesTotal` is only how many files the
 * stream has *mentioned* so far, so a fraction would invent a target the model
 * never announced and would crawl toward 100% forever. Counts come from the
 * selector; nothing here re-scans text.
 */
export function streamProgressLabel(progress: StreamingFilesSummary | null): string | null {
  if (!progress || progress.filesTotal === 0) return null;
  const written =
    progress.filesWritten === 1 ? '1 file written' : `${progress.filesWritten} files written`;
  if (!progress.activePath) return written;
  if (progress.filesWritten === 0) return `Writing ${progress.activePath}`;
  return `Writing ${progress.activePath} · ${written}`;
}

/**
 * The same sentence for callers holding `GenerationProgressState.files` rather
 * than a summary — this indicator, the code panel header, and the workspace
 * status block. It exists so no second site calls `summarizeStreamingFiles`
 * itself and lets the two lines drift apart.
 */
export function streamingFilesLabel(
  files: readonly GenerationFile[] | null | undefined,
): string | null {
  if (!files || files.length === 0) return null;
  return streamProgressLabel(summarizeStreamingFiles(files));
}

export default function BuildingIndicator({
  trigger,
  queueAhead,
  files,
}: {
  trigger?: PlanTrigger | null;
  queueAhead?: number | null;
  /** `GenerationProgressState.files`; drives the "writing X" line. */
  files?: GenerationFile[] | null;
}) {
  const streaming = streamingFilesLabel(files);
  const label =
    queueAhead && queueAhead > 0
      ? `In queue — ${queueAhead} builds ahead`
      : (streaming ??
        (trigger === 'followup' ? 'Building your changes…' : 'Building your project…'));

  return (
    <div
      role="status"
      aria-live="polite"
      className="relative mb-16 flex items-center gap-8 overflow-hidden rounded-16 border border-[var(--studio-line)] bg-[var(--studio-bg)] px-14 py-10 text-[13px] text-[var(--studio-muted)]"
    >
      <Loader2 className="size-15 shrink-0 animate-spin text-[var(--studio-accent)] motion-reduce:animate-none" />
      <span className="min-w-0 truncate">{label}</span>
      {/* Light traveling the bottom edge — the build reads as alive even when
          no chat frame has arrived yet. Honest: it shows activity, never progress. */}
      <span aria-hidden className="absolute inset-x-0 bottom-0 h-2 overflow-hidden">
        <span className="studio-sheen block h-full w-1/4 rounded-full bg-gradient-to-r from-transparent via-[var(--studio-accent)] to-transparent" />
      </span>
    </div>
  );
}
