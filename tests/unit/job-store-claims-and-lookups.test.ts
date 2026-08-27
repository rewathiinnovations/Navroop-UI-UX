import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The SQL `lib/jobs/store.ts` sends, read as text.
 *
 * Nothing here executes against Postgres: the unit suite has no database, and the two
 * properties that matter are properties of the *statement*, not of a row that comes back.
 * A kind filter applied after `ORDER BY "createdAt" DESC LIMIT 1` filters a row that has
 * already been chosen, and a claim predicate that also accepts an already-claimed row is
 * not a claim — neither is visible from a return value, and a fake that re-implemented the
 * `WHERE` would only be testing the fake. `raw-sql-composition.test.ts` reads the source
 * for the same reason.
 */

type RawCall = { kind: 'query' | 'execute'; sql: string; values: unknown[] };

const calls = vi.hoisted(() => ({ list: [] as RawCall[] }));
const answers = vi.hoisted(() => ({ rows: [] as unknown[][] }));

/** Renders a tagged template back into the statement Postgres receives. */
function renderTemplate(strings: TemplateStringsArray, values: unknown[]) {
  return strings.reduce(
    (text, part, index) => text + part + (index < values.length ? `$${index + 1}` : ''),
    '',
  );
}

function nextRows(): unknown[] {
  return answers.rows.shift() ?? [];
}

const prisma = vi.hoisted(() => {
  const record = (kind: 'query' | 'execute') =>
    function raw(first: unknown, ...values: unknown[]) {
      const sql = Array.isArray((first as TemplateStringsArray)?.raw)
        ? renderTemplate(first as TemplateStringsArray, values)
        : String(first);
      calls.list.push({ kind, sql, values });
      return Promise.resolve(kind === 'query' ? nextRows() : 1);
    };
  const client = {
    $queryRaw: record('query'),
    $queryRawUnsafe: record('query'),
    $executeRaw: record('execute'),
    $executeRawUnsafe: record('execute'),
    $transaction: (fn: (tx: unknown) => unknown) => Promise.resolve(fn(client)),
  };
  return client;
});

vi.mock('@/lib/db', () => ({ prisma }));

const {
  claimAuditJobStep,
  claimScanAttempt,
  getActiveJobOfKinds,
  getLatestJobOfKinds,
  getLatestJobByKind,
} = await import('@/lib/jobs/store');

/** Whitespace-insensitive, so an indent change in the source is not a failure. */
function flat(sql: string) {
  return sql.replace(/\s+/g, ' ').trim();
}

function lastSql() {
  return flat(calls.list[calls.list.length - 1]?.sql ?? '');
}

beforeEach(() => {
  calls.list = [];
  answers.rows = [];
});

describe('getLatestJobOfKinds', () => {
  /**
   * The fan-out this replaced — `getLatestJobByKind` once per `CHAT_JOB_KINDS` entry — sat
   * on the workspace poll, which runs every 2s per open viewer while a project is in
   * BUILDING, and answered every tick with four statements instead of one.
   */
  it('asks for the whole kind set in one statement', async () => {
    await getLatestJobOfKinds('proj-1', ['PLAN', 'BUILD', 'FOLLOWUP', 'IMPORT']);

    expect(calls.list).toHaveLength(1);
    expect(lastSql()).toContain('kind::text = ANY($2::text[])');
    expect(lastSql()).toContain('WHERE "projectId" = $1');
    expect(lastSql()).toContain('ORDER BY "createdAt" DESC LIMIT 1');
    expect(calls.list[0].values).toEqual(['proj-1', ['PLAN', 'BUILD', 'FOLLOWUP', 'IMPORT']]);
  });

  it('costs one statement whatever the set size, unlike the per-kind lookup', async () => {
    await getLatestJobOfKinds('proj-1', ['PLAN', 'BUILD', 'FOLLOWUP', 'IMPORT']);
    const oneShot = calls.list.length;

    calls.list = [];
    for (const kind of ['PLAN', 'BUILD', 'FOLLOWUP', 'IMPORT'] as const) {
      await getLatestJobByKind('proj-1', kind);
    }

    expect(oneShot).toBe(1);
    expect(calls.list).toHaveLength(4);
  });

  it('answers null when the project has no row of those kinds', async () => {
    expect(await getLatestJobOfKinds('proj-1', ['BUILD'])).toBeNull();
  });

  it('maps the row it finds', async () => {
    answers.rows = [
      [
        {
          id: 'job-1',
          projectId: 'proj-1',
          kind: 'BUILD',
          status: 'SUCCEEDED',
          estimatedCostUsd: '0.25',
          partialFiles: null,
          steps: null,
          resourceIds: null,
          createdAt: new Date('2026-08-20T10:00:00.000Z'),
        },
      ],
    ];

    const job = await getLatestJobOfKinds('proj-1', ['BUILD']);

    expect(job).toMatchObject({ id: 'job-1', status: 'SUCCEEDED', estimatedCostUsd: 0.25 });
  });
});

describe('getActiveJobOfKinds', () => {
  /**
   * `getActiveJob` is kind-blind, which is right for `one_active_job_per_project` and wrong
   * for "is a scan of this flavour already live?" — that question gets a yes about the
   * user's own running build.
   */
  it('keeps both the live-status guard and the kind set in the statement', async () => {
    await getActiveJobOfKinds('proj-1', ['AUDIT']);

    expect(calls.list).toHaveLength(1);
    expect(lastSql()).toContain("status IN ('QUEUED', 'RUNNING')");
    expect(lastSql()).toContain('kind::text = ANY($2::text[])');
    expect(calls.list[0].values).toEqual(['proj-1', ['AUDIT']]);
  });
});

describe('claimAuditJobStep', () => {
  /**
   * The predicate used to end `OR "currentStep" = ${step}`, which excluded the other scan
   * flavour and welcomed a second instance of the same one: two `runCodeAudit` calls on
   * different app instances both matched a row already stamped `code-audit`, both drove the
   * heartbeat and the field writes on it, and both settled it. `updateJobIfActive` makes the
   * second settle a silent no-op, so a scan that failed after the other succeeded left
   * /admin/jobs reporting success for a run that errored.
   */
  it('claims only a row nobody has stamped', async () => {
    answers.rows = [[{ id: 'job-audit' }]];

    await claimAuditJobStep('job-audit', 'code-audit');

    // The predicate only — the SET clause writes `"currentStep" = $1`, which is the stamp.
    const where = lastSql().split(' WHERE ')[1] ?? '';
    expect(where).toContain('"currentStep" IS NULL');
    // The disjunct that made the claim non-exclusive. Any equality test against the step
    // being claimed hands the row to a second instance of the same scan.
    expect(where).not.toMatch(/"currentStep"\s*=\s*\$\d/);
  });

  it('still refuses a row of another kind or one that has settled', async () => {
    answers.rows = [[{ id: 'job-audit' }]];

    await claimAuditJobStep('job-audit', 'code-audit');

    expect(lastSql()).toContain('kind = \'AUDIT\'::"JobKind"');
    expect(lastSql()).toContain("status IN ('QUEUED', 'RUNNING')");
  });

  /** The win is the returned row count — never a re-read, which is the race itself. */
  it('reports the claim from the rows the UPDATE returned, and reads nothing back', async () => {
    answers.rows = [[{ id: 'job-audit' }]];
    expect(await claimAuditJobStep('job-audit', 'code-audit')).toBe(true);
    expect(calls.list).toHaveLength(1);
    expect(lastSql()).toContain('RETURNING id');

    calls.list = [];
    answers.rows = [[]];
    expect(await claimAuditJobStep('job-audit', 'code-audit')).toBe(false);
    expect(calls.list).toHaveLength(1);
  });
});

describe('claimScanAttempt', () => {
  const input = {
    projectId: 'proj-1',
    userId: 'user-1',
    step: 'code-audit',
    since: new Date('2026-08-20T10:00:00.000Z'),
    startedAt: new Date('2026-08-20T10:00:05.000Z'),
  };

  /**
   * The durable half of the unmetered-scan bound used to be written *after* the scan
   * finished, so while the provider call was in flight nothing outside the process knew an
   * attempt existed: two POSTs of one replayed warrant on two instances each found no
   * attempt row and each ran a free AI review. The row goes in first.
   */
  it('records the attempt before returning, and returns the row it wrote', async () => {
    answers.rows = [[]];

    const id = await claimScanAttempt(input);

    expect(id).toBeTruthy();
    const insert = calls.list.find((call) => call.sql.includes('INSERT INTO "GenerationJob"'));
    expect(insert).toBeDefined();
    expect(flat(insert?.sql ?? '')).toContain('\'AUDIT\'::"JobKind"');
    // The marker `codeScanAttemptedSince` looks for, and the start instant it compares
    // against the build's `finishedAt` — both have to be on the row from the first write.
    expect(insert?.values).toContain(input.step);
    expect(insert?.values).toContain(input.startedAt);
    // Terminal from its first statement: `one_active_job_per_project` is kind-blind, so a
    // live scan row answers "a build is already running" to the user's next message.
    expect(insert?.values).toContain('ABANDONED');
    expect(insert?.values).not.toContain('RUNNING');
    expect(insert?.values).not.toContain('QUEUED');
  });

  it('takes a transaction-scoped lock on (project, step) before it reads', async () => {
    answers.rows = [[]];

    await claimScanAttempt(input);

    // Order is the point. `INSERT … WHERE NOT EXISTS` as one statement is not exclusive
    // under READ COMMITTED — both instances snapshot before either inserts — so the read
    // has to happen after the lock, in a snapshot taken once the winner has committed.
    expect(calls.list[0].sql).toContain('pg_advisory_xact_lock');
    expect(calls.list[0].values).toContain('scan-attempt:proj-1:code-audit');
    expect(calls.list[1].sql).toContain('SELECT id FROM "GenerationJob"');
    expect(flat(calls.list[1].sql)).toContain('"createdAt" >=');
  });

  it('writes nothing when an attempt in this window already exists', async () => {
    answers.rows = [[{ id: 'job-earlier' }]];

    const id = await claimScanAttempt(input);

    expect(id).toBeNull();
    expect(calls.list.some((call) => call.sql.includes('INSERT INTO'))).toBe(false);
  });
});
