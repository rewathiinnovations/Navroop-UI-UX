const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

function plural(count: number, unit: string) {
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

/** Human relative time: "3 hours ago", "just now". Pass `now` so SSR and hydration share one clock. */
export function formatRelativeTime(value: string | Date, now: number = Date.now()) {
  const date = typeof value === "string" ? new Date(value) : value;
  const seconds = Math.round((now - date.getTime()) / 1000);
  if (Number.isNaN(seconds)) return "";
  if (seconds < 45) return "just now";
  if (seconds < HOUR) return plural(Math.max(1, Math.round(seconds / MINUTE)), "minute");
  if (seconds < DAY) return plural(Math.round(seconds / HOUR), "hour");
  if (seconds < MONTH) return plural(Math.round(seconds / DAY), "day");
  if (seconds < YEAR) return plural(Math.round(seconds / MONTH), "month");
  return plural(Math.round(seconds / YEAR), "year");
}

export function withRelativeLabels<T extends { id: string; name: string; updatedAt?: string | Date }>(
  items: T[],
  now: number = Date.now(),
): Array<{ id: string; name: string; updatedLabel?: string }> {
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    updatedLabel: item.updatedAt ? formatRelativeTime(item.updatedAt, now) : undefined,
  }));
}
