/**
 * The four invariants that exist only in migration SQL (F-309, F-352).
 *
 * Partial indexes, expression indexes, triggers and functions have no
 * representation in `prisma/schema.prisma`, so any schema-first rebuild —
 * `prisma db push`, a `migrate reset` against the datamodel, a restore that
 * replayed the datamodel rather than the migrations — brings back a database
 * that looks right and has quietly lost all four. Nothing announces that: it
 * surfaces weeks later as two concurrent generations for one project, a
 * retried submit charged twice, a preview DNS label colliding with a live one,
 * or a workspace with no admin left.
 *
 * `tests/integration/db-invariants.test.ts` asserts them against the test
 * database inside `pnpm run verify`, which is where the mistake is made. This
 * module is the other half F-352 asked for: the same list, checked against the
 * database a running deployment is actually connected to, reported at boot as
 * a non-fatal check. Non-fatal on purpose — no code path drops a trigger, so a
 * fatal probe would guard a moment when nothing can go wrong while handing a
 * transient database hiccup the power to stop the container from starting.
 */
import { prisma } from './db';
import { log, logError } from './logger';
import { getObservabilityStore } from './observability/store';

export type DatabaseInvariant = {
  /** Postgres object name. */
  name: string;
  kind: 'index' | 'trigger';
  /** Table the object hangs off, for the trigger lookup and for the report. */
  table: string;
  /** What breaks, in the operator's terms, while it is missing. */
  matters: string;
  /**
   * Substrings the index definition must contain. The predicate is the whole
   * point of a partial index — a plain unique index on the same column would
   * forbid a project's second job forever — so the shape is asserted, not just
   * the name.
   */
  definitionIncludes: string[];
};

export const DATABASE_INVARIANTS: DatabaseInvariant[] = [
  {
    name: 'one_active_job_per_project',
    kind: 'index',
    table: 'GenerationJob',
    matters: 'two concurrent generations for one project both run and both charge credits',
    definitionIncludes: ['UNIQUE', 'projectId', 'QUEUED', 'RUNNING'],
  },
  {
    name: 'generation_job_project_idempotency_key',
    kind: 'index',
    table: 'GenerationJob',
    matters: 'a retried submit is charged twice',
    definitionIncludes: ['UNIQUE', 'idempotencyKey'],
  },
  {
    name: 'Deployment_dns_label_key',
    kind: 'index',
    table: 'Deployment',
    matters: 'a LIVE slug can collide with the DNS label of a PREVIEW deploy',
    definitionIncludes: ['UNIQUE', 'preview-'],
  },
  {
    name: 'user_prevent_last_admin',
    kind: 'trigger',
    table: 'User',
    matters: 'the last active admin can be demoted or deactivated, locking the workspace out',
    definitionIncludes: [],
  },
];

export type InvariantProbe = {
  name: string;
  kind: DatabaseInvariant['kind'];
  table: string;
  matters: string;
  present: boolean;
  /** Index definition as Postgres reports it; null for a trigger or a miss. */
  definition: string | null;
  /** Present, but not the shape the migration created. */
  malformed: boolean;
};

export type InvariantReport = {
  checkedAt: string;
  probes: InvariantProbe[];
  /** Names that are missing or the wrong shape. Empty is the healthy answer. */
  broken: string[];
};

/** The slice of a Prisma client this module uses. */
export type InvariantSqlClient = {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
};

export async function checkDatabaseInvariants(
  client: InvariantSqlClient,
  now: Date = new Date(),
): Promise<InvariantReport> {
  const indexNames = DATABASE_INVARIANTS.filter((row) => row.kind === 'index').map(
    (row) => row.name,
  );
  const triggerNames = DATABASE_INVARIANTS.filter((row) => row.kind === 'trigger').map(
    (row) => row.name,
  );

  const indexRows = await client.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
    SELECT indexname, indexdef FROM pg_indexes WHERE indexname = ANY(${indexNames})
  `;
  // `tgisinternal` excludes the rows Postgres creates for foreign keys and
  // constraints, which would otherwise report a name that is not ours.
  const triggerRows = await client.$queryRaw<Array<{ tgname: string }>>`
    SELECT t.tgname
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE NOT t.tgisinternal AND t.tgname = ANY(${triggerNames})
  `;

  const definitions: Record<string, string> = {};
  for (const row of indexRows) definitions[row.indexname] = row.indexdef;
  const triggers: Record<string, true> = {};
  for (const row of triggerRows) triggers[row.tgname] = true;

  const probes = DATABASE_INVARIANTS.map((invariant) => {
    const definition = invariant.kind === 'index' ? (definitions[invariant.name] ?? null) : null;
    const present =
      invariant.kind === 'index' ? definition !== null : Boolean(triggers[invariant.name]);
    const malformed =
      present &&
      definition !== null &&
      invariant.definitionIncludes.some(
        (fragment) => !definition.toLowerCase().includes(fragment.toLowerCase()),
      );
    return {
      name: invariant.name,
      kind: invariant.kind,
      table: invariant.table,
      matters: invariant.matters,
      present,
      definition,
      malformed,
    };
  });

  return {
    checkedAt: now.toISOString(),
    probes,
    broken: probes.filter((probe) => !probe.present || probe.malformed).map((probe) => probe.name),
  };
}

export type InvariantReportDeps = {
  client?: InvariantSqlClient;
  now?: Date;
  createCheck?: (row: {
    kind: string;
    ok: boolean;
    eventId: null;
    detail: string;
    createdAt: Date;
  }) => Promise<unknown>;
};

/**
 * The boot step (`instrumentation.ts`, optional). Records the result of the
 * probe as an `ObservabilityCheck` row so `/admin/health` can show it for the
 * database this deployment is connected to, and logs a missing invariant at
 * error level — the absence F-352 filed was silent, and a check nobody can see
 * is still silent.
 */
export async function reportDatabaseInvariants(deps: InvariantReportDeps = {}) {
  const now = deps.now ?? new Date();
  const report = await checkDatabaseInvariants(deps.client ?? prisma, now);
  if (report.broken.length > 0) {
    const broken = report.probes.filter((probe) => report.broken.includes(probe.name));
    logError(
      'db.invariants_missing',
      new Error(
        `Database-only invariants missing or malformed: ${broken
          .map(
            (probe) =>
              `${probe.name} (${probe.present ? 'wrong shape' : 'absent'}) — ${probe.matters}`,
          )
          .join('; ')}`,
      ),
      { broken: report.broken },
    );
  } else {
    log.info('db.invariants_ok', { checked: report.probes.length });
  }

  const createCheck = deps.createCheck ?? ((row) => getObservabilityStore().createCheck(row));
  await createCheck({
    kind: 'db_invariants',
    ok: report.broken.length === 0,
    eventId: null,
    detail: JSON.stringify({
      broken: report.broken,
      probes: report.probes.map((probe) => ({
        name: probe.name,
        present: probe.present,
        malformed: probe.malformed,
      })),
    }),
    createdAt: now,
  });

  return report;
}

/**
 * For `/admin/health`. A probe that cannot run is reported as unknown rather
 * than as healthy: the endpoint answers about six other subsystems and must
 * not 500 over this one, but "could not be checked" and "all four present" are
 * different answers and the panel says which it got.
 */
export async function loadInvariantReport(
  deps: InvariantReportDeps = {},
): Promise<InvariantReport | null> {
  try {
    return await checkDatabaseInvariants(deps.client ?? prisma, deps.now ?? new Date());
  } catch (error) {
    logError('db.invariants_unreadable', error, {});
    return null;
  }
}
