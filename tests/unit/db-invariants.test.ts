import { describe, expect, it, vi } from 'vitest';
import {
  DATABASE_INVARIANTS,
  checkDatabaseInvariants,
  loadInvariantReport,
  reportDatabaseInvariants,
  type InvariantSqlClient,
} from '@/lib/db-invariants';

/**
 * F-352: nothing checked, against the database a deployment is connected to,
 * that the four migration-only invariants are there. `pnpm run verify` proves
 * them for the *test* database (`tests/integration/db-invariants.test.ts`),
 * which catches the developer who rebuilt the schema from the datamodel — but
 * says nothing about a production database that was pushed to rather than
 * migrated, or restored from a datamodel-shaped dump.
 *
 * The probe is a `pg_indexes` / `pg_trigger` read, so these tests drive it with
 * a stub client: the queries are exercised for real against Postgres in the
 * integration suite, and the classification — absent, malformed, healthy — is
 * decided here.
 */

const INDEX_DEFS: Record<string, string> = {
  one_active_job_per_project:
    'CREATE UNIQUE INDEX one_active_job_per_project ON public."GenerationJob" USING btree ("projectId") WHERE (status = ANY (ARRAY[\'QUEUED\'::"JobStatus", \'RUNNING\'::"JobStatus"]))',
  generation_job_project_idempotency_key:
    'CREATE UNIQUE INDEX generation_job_project_idempotency_key ON public."GenerationJob" USING btree ("projectId", "idempotencyKey") WHERE ("idempotencyKey" IS NOT NULL)',
  Deployment_dns_label_key:
    'CREATE UNIQUE INDEX "Deployment_dns_label_key" ON public."Deployment" USING btree ((CASE WHEN (kind = \'PREVIEW\'::"DeploymentKind") THEN (\'preview-\'::text || slug) ELSE slug END))',
};

/**
 * Answers the two queries the probe makes, in order, from whatever the case
 * says the database contains.
 */
function stubClient(present: { indexes: Record<string, string>; triggers: string[] }) {
  let call = 0;
  const client: InvariantSqlClient = {
    async $queryRaw<T>() {
      call += 1;
      if (call === 1) {
        return Object.entries(present.indexes).map(([indexname, indexdef]) => ({
          indexname,
          indexdef,
        })) as T;
      }
      return present.triggers.map((tgname) => ({ tgname })) as T;
    },
  };
  return client;
}

const HEALTHY = { indexes: INDEX_DEFS, triggers: ['user_prevent_last_admin'] };

describe('the invariant list', () => {
  it('names the four objects the migrations create and nothing else', () => {
    expect(DATABASE_INVARIANTS.map((row) => row.name).sort()).toEqual([
      'Deployment_dns_label_key',
      'generation_job_project_idempotency_key',
      'one_active_job_per_project',
      'user_prevent_last_admin',
    ]);
    // Every entry says what breaks while it is absent: that sentence is what
    // an operator reading /admin/health at 2am has to act on.
    for (const row of DATABASE_INVARIANTS) {
      expect(row.matters.trim(), row.name).not.toBe('');
    }
  });
});

describe('checkDatabaseInvariants', () => {
  it('reports nothing broken when all four are present and the right shape', async () => {
    const report = await checkDatabaseInvariants(stubClient(HEALTHY));
    expect(report.broken).toEqual([]);
    expect(report.probes).toHaveLength(4);
    expect(report.probes.every((probe) => probe.present)).toBe(true);
  });

  it('reports a dropped index', async () => {
    const indexes = { ...INDEX_DEFS };
    delete indexes.one_active_job_per_project;
    const report = await checkDatabaseInvariants(stubClient({ ...HEALTHY, indexes }));
    expect(report.broken).toEqual(['one_active_job_per_project']);
    expect(
      report.probes.find((probe) => probe.name === 'one_active_job_per_project'),
    ).toMatchObject({ present: false, definition: null });
  });

  it('reports a dropped trigger', async () => {
    const report = await checkDatabaseInvariants(stubClient({ ...HEALTHY, triggers: [] }));
    expect(report.broken).toEqual(['user_prevent_last_admin']);
  });

  it('reports an index that is present but the wrong shape', async () => {
    // The predicate is the invariant. A plain unique index on "projectId"
    // carries the same name, passes an existence check, and forbids a project
    // from ever having a second job — the opposite of what it is for.
    const report = await checkDatabaseInvariants(
      stubClient({
        ...HEALTHY,
        indexes: {
          ...INDEX_DEFS,
          one_active_job_per_project:
            'CREATE UNIQUE INDEX one_active_job_per_project ON public."GenerationJob" USING btree ("projectId")',
        },
      }),
    );
    expect(report.broken).toEqual(['one_active_job_per_project']);
    expect(
      report.probes.find((probe) => probe.name === 'one_active_job_per_project'),
    ).toMatchObject({ present: true, malformed: true });
  });

  it('reports everything broken when the database has none of them', async () => {
    const report = await checkDatabaseInvariants(stubClient({ indexes: {}, triggers: [] }));
    expect(report.broken).toHaveLength(4);
  });
});

describe('reportDatabaseInvariants', () => {
  it('records an ok check row and logs nothing at error level when healthy', async () => {
    const rows: Array<{ kind: string; ok: boolean }> = [];
    const report = await reportDatabaseInvariants({
      client: stubClient(HEALTHY),
      createCheck: async (row) => {
        rows.push(row);
        return row;
      },
    });
    expect(report.broken).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'db_invariants', ok: true });
  });

  it('records a failed check row naming what is broken', async () => {
    const rows: Array<{ kind: string; ok: boolean; detail: string }> = [];
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    let logged: string[] = [];
    try {
      await reportDatabaseInvariants({
        client: stubClient({ ...HEALTHY, triggers: [] }),
        createCheck: async (row) => {
          rows.push(row);
          return row;
        },
      });
      // Read before restoring: `mockRestore` clears the recorded calls too.
      logged = errors.mock.calls.map((call) => String(call[0]));
    } finally {
      errors.mockRestore();
    }
    expect(rows[0].ok).toBe(false);
    expect(JSON.parse(rows[0].detail).broken).toEqual(['user_prevent_last_admin']);
    // Not silent: the whole finding is that the absence announces itself
    // nowhere. A row in the database is the /admin/health signal; the log line
    // is what reaches Sentry, and it names the object and the consequence.
    expect(logged.join('\n')).toContain('user_prevent_last_admin');
    expect(logged.join('\n')).toContain('locking the workspace out');
  });
});

describe('loadInvariantReport', () => {
  it('answers null — not a healthy report — when the probe cannot run', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const report = await loadInvariantReport({
        client: {
          async $queryRaw<T>(): Promise<T> {
            throw new Error('connection refused');
          },
        },
      });
      expect(report).toBeNull();
    } finally {
      errors.mockRestore();
    }
  });
});
