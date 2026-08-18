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
      className="flex items-center justify-between gap-8 border-b border-sky-200 bg-sky-50 px-12 py-8 text-[12px] text-sky-950"
      role="status"
    >
      <p>This project has new changes — refresh the page</p>
      <button
        type="button"
        onClick={onRefresh}
        className="shrink-0 rounded-8 border border-sky-300 bg-white px-8 py-4 text-[11px] font-medium text-sky-950 hover:bg-sky-100"
      >
        Refresh
      </button>
    </div>
  );
}
