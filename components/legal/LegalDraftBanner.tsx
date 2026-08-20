/**
 * `/terms`, `/privacy` and `/legal` render inside `app/(legal)/layout.tsx`, which
 * is a `.studio-shell`, so this paints with the studio warning tokens. It used to
 * carry `border-amber-300 bg-amber-50 text-amber-950` with no `dark:` pair, which
 * left the banner a light-mode card on a dark page.
 */
export default function LegalDraftBanner() {
  return (
    <p
      className="rounded-10 border border-[var(--studio-warning-line)] bg-[var(--studio-warning-soft)] px-14 py-10 text-[13px] leading-5 text-[var(--studio-warning)]"
      role="status"
    >
      Draft — lawyer review required before public launch.
    </p>
  );
}
