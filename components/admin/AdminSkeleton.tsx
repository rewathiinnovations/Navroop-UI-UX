import { cn } from '@/utils/cn';

/**
 * Loading placeholders shaped like the content they stand in for.
 *
 * The admin dashboards used to render "Loading…" text (or nothing), so a slow
 * fetch flashed an empty frame and then shoved the layout down when data
 * arrived. A skeleton the same size as the finished card keeps the geometry
 * stable and reads as activity without a spinner.
 *
 * Uses the existing `--studio-skeleton` token; the pulse respects
 * `prefers-reduced-motion` via Tailwind's `motion-reduce`.
 */

function Bone({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'block animate-pulse rounded-8 bg-[var(--studio-skeleton)] motion-reduce:animate-none',
        className,
      )}
    />
  );
}

/** A row of stat-tile-shaped placeholders (matches `StatTile`). */
export function SkeletonStats({ count = 4 }: { count?: number }) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className="grid grid-cols-2 gap-12 lg:grid-cols-4"
    >
      {Array.from({ length: count }, (_, index) => (
        <div
          key={index}
          className="flex items-start gap-12 rounded-14 border border-[var(--studio-line)] bg-[var(--studio-surface)] p-16"
        >
          <Bone className="size-34 shrink-0 rounded-10" />
          <div className="min-w-0 flex-1 space-y-8 pt-2">
            <Bone className="h-18 w-1/2" />
            <Bone className="h-10 w-3/4" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Table-shaped placeholder rows (matches `AdminTable` paddings). */
export function SkeletonTable({ rows = 4, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className="overflow-hidden rounded-14 border border-[var(--studio-line)]"
    >
      <div className="border-b border-[var(--studio-line)] bg-[var(--studio-bg)]/60 px-14 py-12">
        <Bone className="h-10 w-1/3" />
      </div>
      {Array.from({ length: rows }, (_, row) => (
        <div
          key={row}
          className="flex items-center gap-14 border-b border-[var(--studio-line)] px-14 py-12 last:border-b-0"
        >
          {Array.from({ length: cols }, (_, col) => (
            <Bone key={col} className={cn('h-12', col === 0 ? 'w-1/4' : 'flex-1')} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Free-form text lines (matches card body copy). */
export function SkeletonLines({ lines = 3 }: { lines?: number }) {
  return (
    <div role="status" aria-label="Loading" className="space-y-10">
      {Array.from({ length: lines }, (_, index) => (
        <Bone key={index} className={cn('h-12', index === lines - 1 ? 'w-1/2' : 'w-full')} />
      ))}
    </div>
  );
}
