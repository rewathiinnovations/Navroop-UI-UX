import { randomBytes } from 'node:crypto';
import type { CronRunRow, ObservabilityCheckRow, ObservabilityStore } from './types';

type RawDb = {
  $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
  $queryRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
};

function newId() {
  return `c${randomBytes(12).toString('hex')}`;
}

type RawCheck = {
  id: string;
  kind: string;
  ok: boolean;
  detail: string | null;
  eventId: string | null;
  createdAt: Date;
};

type RawCron = {
  id: string;
  name: string;
  ok: boolean;
  durationMs: number | null;
  detail: string | null;
  createdAt: Date;
};

export function createPrismaObservabilityStore(db: RawDb): ObservabilityStore {
  return {
    async createCheck(row) {
      const created: ObservabilityCheckRow = {
        id: row.id ?? newId(),
        kind: row.kind,
        ok: row.ok,
        detail: row.detail ?? null,
        eventId: row.eventId ?? null,
        createdAt: row.createdAt,
      };
      await db.$executeRaw`
        INSERT INTO "ObservabilityCheck" ("id", "kind", "ok", "detail", "eventId", "createdAt")
        VALUES (${created.id}, ${created.kind}, ${created.ok}, ${created.detail}, ${created.eventId}, ${created.createdAt})
      `;
      return created;
    },
    async listChecks(kind) {
      const rows = kind
        ? ((await db.$queryRaw`
            SELECT "id", "kind", "ok", "detail", "eventId", "createdAt"
            FROM "ObservabilityCheck"
            WHERE "kind" = ${kind}
            ORDER BY "createdAt" DESC
            LIMIT 100
          `) as RawCheck[])
        : ((await db.$queryRaw`
            SELECT "id", "kind", "ok", "detail", "eventId", "createdAt"
            FROM "ObservabilityCheck"
            ORDER BY "createdAt" DESC
            LIMIT 200
          `) as RawCheck[]);
      return rows.map((row) => ({
        ...row,
        createdAt: new Date(row.createdAt),
      }));
    },
    async createCronRun(row) {
      const created: CronRunRow = {
        id: row.id ?? newId(),
        name: row.name,
        ok: row.ok,
        durationMs: row.durationMs ?? null,
        detail: row.detail ?? null,
        createdAt: row.createdAt,
      };
      await db.$executeRaw`
        INSERT INTO "CronRun" ("id", "name", "ok", "durationMs", "detail", "createdAt")
        VALUES (${created.id}, ${created.name}, ${created.ok}, ${created.durationMs}, ${created.detail}, ${created.createdAt})
      `;
      return created;
    },
    // Deliberately one name at a time. The unfiltered variant was a single `LIMIT 400` across
    // every cron name, and `reap-jobs` plus `check-domains` alone write ~2160 rows a day, so
    // the window held under three hours of history while `CRON_STALE_MS` budgets up to eight
    // days: every daily and weekly job read as "never-run". Health surfaces use
    // `listLatestCronRunPerName` instead, which cannot be truncated.
    async listCronRuns(name) {
      const rows = (await db.$queryRaw`
        SELECT "id", "name", "ok", "durationMs", "detail", "createdAt"
        FROM "CronRun"
        WHERE "name" = ${name}
        ORDER BY "createdAt" DESC
        LIMIT 50
      `) as RawCron[];
      return rows.map((row) => ({
        ...row,
        createdAt: new Date(row.createdAt),
      }));
    },
    async listLatestCronRunPerName() {
      const rows = (await db.$queryRaw`
        SELECT DISTINCT ON ("name") "id", "name", "ok", "durationMs", "detail", "createdAt"
        FROM "CronRun"
        ORDER BY "name", "createdAt" DESC
      `) as RawCron[];
      return rows.map((row) => ({
        ...row,
        createdAt: new Date(row.createdAt),
      }));
    },
  };
}

let defaultStore: ObservabilityStore | null = null;

export function getObservabilityStore() {
  if (!defaultStore) {
    defaultStore = createLazyPrismaStore();
  }
  return defaultStore;
}

function createLazyPrismaStore(): ObservabilityStore {
  let inner: ObservabilityStore | null = null;
  async function ensure() {
    if (!inner) {
      const { prisma } = await import('../db');
      inner = createPrismaObservabilityStore(prisma);
    }
    return inner;
  }
  return {
    async createCheck(row) {
      return (await ensure()).createCheck(row);
    },
    async listChecks(kind) {
      return (await ensure()).listChecks(kind);
    },
    async createCronRun(row) {
      return (await ensure()).createCronRun(row);
    },
    async listCronRuns(name) {
      return (await ensure()).listCronRuns(name);
    },
    async listLatestCronRunPerName() {
      return (await ensure()).listLatestCronRunPerName();
    },
  };
}
