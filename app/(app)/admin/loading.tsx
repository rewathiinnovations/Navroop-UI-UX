import { SkeletonStats, SkeletonTable } from '@/components/admin/AdminSkeleton';

/**
 * Every admin page is an async dashboard reading live infrastructure — provider health,
 * Coolify servers, job rows — so each one blocked on a network round trip behind an empty
 * frame (F-445). This sits inside `admin/layout.tsx`, so the rail is already painted and
 * navigable while the numbers arrive.
 *
 * Deliberately stat-tiles-over-a-table: that is the shape of nearly every dashboard here,
 * and the individual pages already own the same primitives for their in-page refreshes.
 */
export default function AdminLoading() {
  return (
    <div className="space-y-24">
      <div
        role="status"
        aria-label="Loading"
        className="h-24 w-[180px] animate-pulse rounded-8 bg-[var(--studio-skeleton)] motion-reduce:animate-none"
      />
      <SkeletonStats count={4} />
      <SkeletonTable rows={6} cols={4} />
    </div>
  );
}
