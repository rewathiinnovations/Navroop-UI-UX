/**
 * The in-flight marker a cron takes before it starts working (F-708).
 *
 * `handleCron` used to authorise and invoke the body straight away. Nothing stopped a
 * scheduler retry, a slow run overlapping the next tick, a second replica or a hand-fired
 * request from doing the work twice, and concurrent runs are not harmless here: two
 * `backup-db` runs both `pg_dump` into the same volume, and two `purge-projects` runs can
 * both apply `adjustStorageBytes(-bytes)` for one project and permanently corrupt
 * `Workspace.storageBytes`.
 *
 * The claim lives in `AppSetting` rather than in `CronRun`. A `CronRun` row is a *receipt*:
 * `/admin/health` and the daily digest read the latest row per name, so an in-flight row
 * would have to lie in one direction or the other — `ok: true` makes a killed run look
 * healthy, `ok: false` mails the operator "backup-db failed" every time a backup is merely
 * running. Keeping the marker separate leaves `CronRun` meaning what it has always meant,
 * and a run that dies still gets a real failed receipt: the next invocation finds the
 * abandoned claim and records it (see `recordAbandonedCronRun`).
 */

/** Namespaced away from `settings.*` (Admin → Configuration) and the alert keys. */
export const CRON_CLAIM_KEY_PREFIX = 'cron.inflight.';

export function cronClaimKey(name: string) {
  return `${CRON_CLAIM_KEY_PREFIX}${name}`;
}

/**
 * How long a claim may sit unsettled before the next invocation presumes the holder died.
 *
 * This is an in-flight budget, not a schedule interval — deliberately *not*
 * `CRON_STALE_MS`, whose 48-hour entries would wedge a cron for two days after one OOM.
 * The floor is the cost of guessing wrong in each direction: too short doubles the work,
 * too long leaves the schedule stopped. The minute-tick crons need to recover fast; the
 * dump and object-store crons legitimately run for many minutes.
 */
export const DEFAULT_CRON_CLAIM_STALE_MS = 15 * 60 * 1000;

export const CRON_CLAIM_STALE_MS: Record<string, number> = {
  'reap-jobs': 5 * 60 * 1000,
  'check-domains': 5 * 60 * 1000,
  'check-uptime': 5 * 60 * 1000,
  'check-certs': 5 * 60 * 1000,
  'observability-heartbeat': 5 * 60 * 1000,
  'system-checks-digest': 5 * 60 * 1000,
  'thin-checkpoints': 30 * 60 * 1000,
  'purge-projects': 30 * 60 * 1000,
  'cleanup-orphans': 30 * 60 * 1000,
  'backup-db': 60 * 60 * 1000,
  'verify-storage': 60 * 60 * 1000,
};

export function cronClaimStaleMs(name: string) {
  return CRON_CLAIM_STALE_MS[name] ?? DEFAULT_CRON_CLAIM_STALE_MS;
}

export type AbandonedCronRun = {
  runId: string;
  /** ISO timestamp the dead run claimed at. */
  startedAt: string;
  /** How long the claim sat unsettled — a floor on how long the dead run lasted. */
  ageMs: number;
};

export type CronClaim = {
  runId: string;
  startedAt: string;
  /**
   * Drops this invocation's claim and only this one. A run that is presumed dead may still
   * be alive and unwind later; its release must not evict the claim that replaced it.
   */
  release: () => Promise<void>;
};

export type CronClaimOutcome =
  | { claimed: true; claim: CronClaim; abandoned: AbandonedCronRun | null }
  | { claimed: false; runningSince: string };

export type CronClaimStore = {
  claim(name: string, now: Date): Promise<CronClaimOutcome>;
};

type ClaimClient = {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  appSetting: {
    findUnique(args: {
      where: { key: string };
      select: { value: true };
    }): Promise<{ value: string } | null>;
    upsert(args: {
      where: { key: string };
      create: { key: string; value: string };
      update: { value: string };
    }): Promise<unknown>;
    deleteMany(args: { where: { key: string; value: string } }): Promise<{ count: number }>;
  };
};

/** Method syntax so a real `PrismaClient` stays structurally assignable to this. */
type ClaimDb = ClaimClient & {
  $transaction<R>(fn: (client: ClaimClient) => Promise<R>): Promise<R>;
};

type StoredClaim = { runId: string; startedAt: string };

function parseClaim(value: string | null | undefined): StoredClaim | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoredClaim>;
    if (typeof parsed.runId !== 'string' || typeof parsed.startedAt !== 'string') return null;
    if (Number.isNaN(Date.parse(parsed.startedAt))) return null;
    return { runId: parsed.runId, startedAt: parsed.startedAt };
  } catch {
    // A claim nobody can parse cannot be released either, so it must not block forever.
    return null;
  }
}

export function createPrismaCronClaimStore(db: ClaimDb): CronClaimStore {
  return {
    async claim(name, now) {
      const key = cronClaimKey(name);
      const staleMs = cronClaimStaleMs(name);

      const result = await db.$transaction(async (tx) => {
        // Read-check-write on one row. A transaction-scoped advisory lock serialises the
        // decision across connections and replicas; without it two invocations can both
        // read "no claim" under READ COMMITTED and both write one.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
        const row = await tx.appSetting.findUnique({ where: { key }, select: { value: true } });
        const existing = parseClaim(row?.value);

        if (existing) {
          const ageMs = now.getTime() - Date.parse(existing.startedAt);
          if (ageMs < staleMs) {
            return { claimed: false as const, runningSince: existing.startedAt };
          }
        }

        const mine: StoredClaim = {
          runId: `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
          startedAt: now.toISOString(),
        };
        const value = JSON.stringify(mine);
        await tx.appSetting.upsert({
          where: { key },
          create: { key, value },
          update: { value },
        });
        return {
          claimed: true as const,
          mine,
          value,
          abandoned: existing
            ? {
                runId: existing.runId,
                startedAt: existing.startedAt,
                ageMs: Math.max(0, now.getTime() - Date.parse(existing.startedAt)),
              }
            : null,
        };
      });

      if (!result.claimed) return result;

      return {
        claimed: true,
        abandoned: result.abandoned,
        claim: {
          runId: result.mine.runId,
          startedAt: result.mine.startedAt,
          release: async () => {
            // Matching on the value is the compare-and-delete: a run whose claim was already
            // taken over deletes nothing.
            await db.appSetting.deleteMany({ where: { key, value: result.value } });
          },
        },
      };
    },
  };
}

let defaultStore: CronClaimStore | null = null;

export function getCronClaimStore(): CronClaimStore {
  if (!defaultStore) {
    let inner: CronClaimStore | null = null;
    defaultStore = {
      async claim(name, now) {
        if (!inner) {
          // Deferred, not selected at runtime: importing `../db` at module scope would
          // instantiate the PrismaClient singleton in every module graph that reaches
          // `handleCron`, which is the same lazy shape `lib/observability/store.ts` uses.
          const { prisma } = await import('../db');
          inner = createPrismaCronClaimStore(prisma);
        }
        return inner.claim(name, now);
      },
    };
  }
  return defaultStore;
}
