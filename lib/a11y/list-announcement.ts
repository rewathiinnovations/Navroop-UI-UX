/**
 * The line a polite live region reads out once an async list settles.
 *
 * Loading placeholders across the product were swapped for their real content
 * with no live region at all, so a screen-reader user got silence between
 * navigation and the list appearing, and no way to tell that a filter had
 * changed the result count. Errors return '' on purpose: every error surface
 * already carries `role="alert"`, which announces itself, and a second polite
 * announcement would read the failure twice.
 */
export function listAnnouncement({
  loading,
  error,
  count,
  noun,
}: {
  loading: boolean;
  /** Empty string when the load succeeded. */
  error: string;
  count: number;
  /** Singular, lower case — 'project', 'skill'. */
  noun: string;
}) {
  if (loading || error) return '';
  if (count === 0) return `No ${noun}s found`;
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
