'use client';

export default function StaleViewBanner({
  visible,
  onRefresh,
}: {
  visible: boolean;
  onRefresh: () => void;
}) {
  if (!visible) return null;
  return (
    <div
      className="flex items-center justify-between gap-8 border-b border-sky-500/25 bg-sky-500/10 px-12 py-8 text-[12px] text-sky-700 dark:text-sky-300"
      role="status"
    >
      <p>This project has new changes — refresh the page</p>
      <button
        type="button"
        onClick={onRefresh}
        className="shrink-0 rounded-8 border border-sky-500/30 bg-[var(--studio-surface)] px-8 py-4 text-[11px] font-medium text-sky-700 hover:bg-sky-500/15 dark:text-sky-300"
      >
        Refresh
      </button>
    </div>
  );
}
