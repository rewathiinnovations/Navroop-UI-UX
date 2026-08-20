const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

function plural(count: number, unit: string) {
  return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
}

/**
 * Human relative time: "3 hours ago", "just now". Pass `now` so SSR and hydration share one clock.
 *
 * A future timestamp used to read "just now" without limit (F-765): `seconds` went negative and
 * fell into the `< 45` branch, so a row whose `updatedAt` is ten days ahead — clock skew between
 * the database host and the app — looked freshly edited forever and sorted to the top of the
 * "Last 14 days" bucket in `lib/projects/list-client.ts`. Skew has to be visible, not absorbed,
 * so anything more than a minute ahead says so.
 */
export function formatRelativeTime(value: string | Date, now: number = Date.now()) {
  const date = typeof value === 'string' ? new Date(value) : value;
  const seconds = Math.round((now - date.getTime()) / 1000);
  if (Number.isNaN(seconds)) return '';
  if (seconds < -MINUTE) return 'in the future';
  if (seconds < 45) return 'just now';
  if (seconds < HOUR) return plural(Math.max(1, Math.round(seconds / MINUTE)), 'minute');
  if (seconds < DAY) return plural(Math.round(seconds / HOUR), 'hour');
  if (seconds < MONTH) return plural(Math.round(seconds / DAY), 'day');
  if (seconds < YEAR) return plural(Math.round(seconds / MONTH), 'month');
  return plural(Math.round(seconds / YEAR), 'year');
}

export function withRelativeLabels<
  T extends { id: string; name: string; updatedAt?: string | Date },
>(
  items: T[],
  now: number = Date.now(),
): Array<{ id: string; name: string; updatedLabel?: string }> {
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    updatedLabel: item.updatedAt ? formatRelativeTime(item.updatedAt, now) : undefined,
  }));
}
