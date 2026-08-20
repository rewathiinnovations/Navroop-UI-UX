import { SkeletonLines, SkeletonStats } from '@/components/admin/AdminSkeleton';

/**
 * The streamed shell for every authenticated page (F-445).
 *
 * `(app)/layout.tsx` awaits the recents, the workspace meta and the session before it
 * renders anything, and had a `Suspense` fallback for the sidebar only — the content column
 * had none, so each page blocked on its own data behind a blank pane. The placeholders are
 * shaped like the widest common case (a heading, a row of tiles, a body) rather than a
 * spinner, so the geometry does not jump when the real content lands.
 */
export default function AppLoading() {
  return (
    <main className="mx-auto max-w-[1100px] px-20 py-40">
      <div
        role="status"
        aria-label="Loading"
        className="mb-24 h-28 w-[220px] animate-pulse rounded-8 bg-[var(--studio-skeleton)] motion-reduce:animate-none"
      />
      <div className="space-y-24">
        <SkeletonStats count={4} />
        <SkeletonLines lines={4} />
      </div>
    </main>
  );
}
