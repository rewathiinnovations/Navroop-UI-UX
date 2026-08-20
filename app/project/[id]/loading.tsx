/**
 * The workspace shell while the page's own data loads (F-445).
 *
 * `project/[id]/page.tsx` awaits three things before it renders — the GitHub connection, the
 * project row and the latest plan — and until this file existed the route showed nothing at
 * all for that whole round trip, then jumped straight to a full two-pane workspace.
 *
 * Shaped like `ProjectWorkspace`: a top bar, a narrow chat column and the preview pane, so
 * the layout the user is waiting for is the layout they are looking at. `--studio-skeleton`
 * and `motion-reduce` are the same tokens the admin placeholders use.
 */

function Bone({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`block animate-pulse rounded-8 bg-[var(--studio-skeleton)] motion-reduce:animate-none ${className ?? ''}`}
    />
  );
}

export default function ProjectLoading() {
  return (
    <div role="status" aria-label="Loading project" className="flex h-dvh flex-col overflow-hidden">
      <div className="flex items-center gap-12 border-b border-[var(--studio-line)] px-16 py-12">
        <Bone className="h-16 w-[160px]" />
        <Bone className="h-16 w-[80px]" />
        <div className="flex-1" />
        <Bone className="h-32 w-[96px] rounded-full" />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="hidden w-[380px] shrink-0 flex-col gap-14 border-r border-[var(--studio-line)] p-16 md:flex">
          <Bone className="h-14 w-3/4" />
          <Bone className="h-14 w-1/2" />
          <Bone className="h-64 w-full rounded-12" />
          <Bone className="h-14 w-2/3" />
          <div className="flex-1" />
          <Bone className="h-44 w-full rounded-12" />
        </div>
        <div className="min-w-0 flex-1 p-16">
          <Bone className="h-full w-full rounded-14" />
        </div>
      </div>
    </div>
  );
}
