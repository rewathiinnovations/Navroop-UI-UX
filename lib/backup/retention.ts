export type RetentionObject = { key: string; lastModified: Date };

const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_MS = 14 * DAY_MS;
const WEEKLY_MS = 8 * 7 * DAY_MS;
const MONTHLY_MS = 365 * DAY_MS;

function isoWeekKey(date: Date) {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function monthKey(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Dailies 14d, weeklies 8w (newest per ISO week), monthlies 12m (newest per month). */
export function retentionDecisions(objects: RetentionObject[], now = new Date()) {
  const dailyCutoff = new Date(now.getTime() - DAILY_MS);
  const weeklyCutoff = new Date(now.getTime() - WEEKLY_MS);
  const monthlyCutoff = new Date(now.getTime() - MONTHLY_MS);
  const sorted = [...objects].sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  const keep = new Set<string>();
  const weeks = new Set<string>();
  const months = new Set<string>();

  for (const object of sorted) {
    if (object.lastModified >= dailyCutoff) keep.add(object.key);
    if (object.lastModified >= weeklyCutoff) {
      const week = isoWeekKey(object.lastModified);
      if (!weeks.has(week)) {
        weeks.add(week);
        keep.add(object.key);
      }
    }
    if (object.lastModified >= monthlyCutoff) {
      const month = monthKey(object.lastModified);
      if (!months.has(month)) {
        months.add(month);
        keep.add(object.key);
      }
    }
  }

  return {
    keep: objects.filter((object) => keep.has(object.key)).map((object) => object.key),
    delete: objects.filter((object) => !keep.has(object.key)).map((object) => object.key),
  };
}
