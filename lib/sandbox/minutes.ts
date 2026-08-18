export const SANDBOX_MINUTES_EXHAUSTED = "This month's sandbox time is used up";
export const DEFAULT_IDLE_MINUTES = 5;
export const EARLY_IDLE_MINUTES = 5;

export function sandboxMinutesBetween(startedAt: Date, endedAt: Date) {
  const ms = endedAt.getTime() - startedAt.getTime();
  if (ms <= 0) return 0;
  return Math.ceil(ms / 60_000);
}

export function canColdStartSandbox(used: number, limit: number) {
  if (limit < 0) return true;
  return used < limit;
}

export function idleMinutesFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const raw = Number.parseInt(env.SANDBOX_IDLE_MINUTES || String(DEFAULT_IDLE_MINUTES), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_IDLE_MINUTES;
}
