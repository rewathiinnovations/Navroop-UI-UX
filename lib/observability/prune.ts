import { prisma } from '../db';
import { positiveNumberSetting } from '../settings/numbers';

/**
 * How long an observability receipt is worth keeping.
 *
 * Nothing in the product reads more than the newest `CronRun` row per name (`/admin/health`
 * and the daily digest) or the last day of `ObservabilityCheck` rows (the heartbeat/quota
 * panels), and until this existed nothing in `lib/`, `app/` or `scripts/` deleted either table
 * — while `reap-jobs` (every minute) and `check-domains` (every 2 minutes) alone write about
 * 2160 `CronRun` rows a day. A month of history is generous for both.
 */
export const OBSERVABILITY_RETENTION_DAYS = 30;

export async function pruneObservabilityHistory(now = new Date()) {
  // `app.observabilityRetentionDays` on /admin/config; the constant above is the default
  // (F-793). How much history to keep for hand inspection is an operator preference —
  // nothing in the product reads past a day.
  const days = await positiveNumberSetting(
    'app.observabilityRetentionDays',
    OBSERVABILITY_RETENTION_DAYS,
  );
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  // The newest row per name survives regardless of age, because that is the row
  // `evaluateSystemChecks` reads: deleting it would turn an honest "stale since <date>" into
  // "never-run", which is the same lie about a cron's history that this cleanup exists to
  // stop telling. `CronRun_name_createdAt_idx` covers the DISTINCT ON.
  const cronRuns = await prisma.$executeRaw`
    DELETE FROM "CronRun"
    WHERE "createdAt" < ${cutoff}
      AND "id" NOT IN (
        SELECT DISTINCT ON ("name") "id" FROM "CronRun" ORDER BY "name", "createdAt" DESC
      )
  `;
  const checks = await prisma.$executeRaw`
    DELETE FROM "ObservabilityCheck"
    WHERE "createdAt" < ${cutoff}
      AND "id" NOT IN (
        SELECT DISTINCT ON ("kind") "id" FROM "ObservabilityCheck" ORDER BY "kind", "createdAt" DESC
      )
  `;
  return { cronRuns, checks, cutoff: cutoff.toISOString() };
}
