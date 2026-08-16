const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

function plural(count: number, unit: string) {
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

/** Human relative time: "3 hours ago", "just now". */
export function formatRelativeTime(value: string | Date) {
  const date = typeof value === "string" ? new Date(value) : value;
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (Number.isNaN(seconds)) return "";
  if (seconds < 45) return "just now";
  if (seconds < HOUR) return plural(Math.max(1, Math.round(seconds / MINUTE)), "minute");
  if (seconds < DAY) return plural(Math.round(seconds / HOUR), "hour");
  if (seconds < MONTH) return plural(Math.round(seconds / DAY), "day");
  if (seconds < YEAR) return plural(Math.round(seconds / MONTH), "month");
  return plural(Math.round(seconds / YEAR), "year");
}
