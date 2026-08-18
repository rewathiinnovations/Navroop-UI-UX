/** Pinned locale so SSR and the browser print the same absolute timestamp. */
export const ADMIN_DATE_LOCALE = 'en-US';

const DATE_TIME_OPTIONS = {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
} as const;

const DATE_OPTIONS = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
} as const;

function toDate(value: string | Date | null | undefined): Date | null {
  if (value == null || value === '') return null;
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

/** Absolute date + time. Host locale is ignored so hydration cannot flip 8/17 vs 17/8. */
export function formatAdminDateTime(value: string | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) return '';
  return date.toLocaleString(ADMIN_DATE_LOCALE, DATE_TIME_OPTIONS);
}

/** Absolute date only. */
export function formatAdminDate(value: string | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) return '';
  return date.toLocaleDateString(ADMIN_DATE_LOCALE, DATE_OPTIONS);
}
