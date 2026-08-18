const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export function nextCheckDelayMs(createdAt: Date, now = new Date()): number | 'failed' {
  const age = now.getTime() - createdAt.getTime();
  if (age >= WEEK) return 'failed';
  if (age < HOUR) return 2 * MINUTE;
  if (age < DAY) return 15 * MINUTE;
  return HOUR;
}

export function shouldCheckDomain(
  createdAt: Date,
  lastCheckedAt: Date | null,
  now = new Date(),
): boolean {
  const delay = nextCheckDelayMs(createdAt, now);
  if (delay === 'failed') return true;
  if (!lastCheckedAt) return true;
  return now.getTime() - lastCheckedAt.getTime() >= delay;
}
