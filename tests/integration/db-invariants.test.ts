import '../setup/env';
import { afterAll, describe, expect, it } from 'vitest';
import { DATABASE_INVARIANTS, checkDatabaseInvariants } from '@/lib/db-invariants';
import { testPrismaClient } from '../setup/db';

/**
 * The four database-only invariants exist in the connected database (F-309, F-352).
 *
 * Partial indexes, expression indexes, triggers and functions have no representation in
 * `prisma/schema.prisma`, so any schema-first rebuild — `prisma db push`, a
 * `migrate reset` against the datamodel, a regenerated baseline — drops them silently.
 * What comes back is a database that looks right and has lost last-admin protection, the
 * one-active-job invariant the entire job state machine rests on, the idempotency key that
 * stops a retried submit being charged twice, and the DNS-label collision guard. None of
 * those absences announce themselves: they surface much later as a duplicate row, a double
 * charge, or a workspace locked out of its own admin surface.
 *
 * This is a test rather than a boot-time assertion on purpose. The invariants cannot go
 * missing at runtime — no code path drops a trigger — so a fatal startup check would guard
 * a moment when nothing can go wrong, while adding a way for a database hiccup to take the
 * product down. They can only disappear when someone rebuilds the schema, which is a
 * developer or CI action, and `vitest` is a fatal step of `pnpm run verify`. So the check
 * fires exactly where the mistake is made, in the same gate that would have shipped it.
 *
 * The schema-side halves — `Deployment.projectId onDelete: Restrict`, and the `///`
 * comments on `User`, `Job`, `Deployment` and `CreditLedger` naming each object — are
 * asserted here too, so the documentation and the database cannot drift apart.
 */

const prisma = testPrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

async function indexDefinition(name: string) {
  const rows = await prisma.$queryRaw<Array<{ indexdef: string }>>`
    SELECT indexdef FROM pg_indexes WHERE indexname = ${name}
  `;
  return rows[0]?.indexdef ?? null;
}

describe('database-only invariants', () => {
  it('keeps one active job per project', async () => {
    const definition = await indexDefinition('one_active_job_per_project');
    expect(definition).toBeTruthy();
    expect(definition).toMatch(/UNIQUE/i);
    // The partial predicate is the invariant: a unique index without it would forbid a
    // project from ever having a second job at all.
    expect(definition).toMatch(/WHERE/i);
    expect(definition).toMatch(/QUEUED/);
    expect(definition).toMatch(/RUNNING/);
  });

  it('keeps a job idempotency key unique per project', async () => {
    const definition = await indexDefinition('generation_job_project_idempotency_key');
    expect(definition).toBeTruthy();
    expect(definition).toMatch(/UNIQUE/i);
    expect(definition).toMatch(/idempotencyKey/);
    // Partial on NOT NULL: without the predicate every job with no key would collide.
    expect(definition).toMatch(/IS NOT NULL/i);
  });

  it('stops a LIVE slug colliding with a PREVIEW DNS label', async () => {
    const definition = await indexDefinition('Deployment_dns_label_key');
    expect(definition).toBeTruthy();
    expect(definition).toMatch(/UNIQUE/i);
    expect(definition).toMatch(/preview-/);
  });

  it('refuses to remove the last active admin', async () => {
    const triggers = await prisma.$queryRaw<Array<{ tgname: string; proname: string }>>`
      SELECT t.tgname, p.proname
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE c.relname = 'User'
        AND t.tgname = 'user_prevent_last_admin'
        AND NOT t.tgisinternal
    `;
    expect(triggers).toHaveLength(1);
    expect(triggers[0].proname).toBe('prevent_last_admin_removal');
  });

  it('restricts hard-deleting a project that still has a deployment', async () => {
    const constraints = await prisma.$queryRaw<Array<{ confdeltype: string }>>`
      SELECT c.confdeltype
      FROM pg_constraint c
      JOIN pg_class child ON child.oid = c.conrelid
      WHERE child.relname = 'Deployment'
        AND c.contype = 'f'
        AND c.conname = 'Deployment_projectId_fkey'
    `;
    expect(constraints).toHaveLength(1);
    // 'r' is RESTRICT. A cascade here would delete the row that names the Coolify
    // application and the DNS record, leaving both running with nothing pointing at them.
    expect(constraints[0].confdeltype).toBe('r');
  });
});

describe('the indexes this migration added', () => {
  it('supports the dashboard project list', async () => {
    const definition = await indexDefinition('Project_deletedAt_updatedAt_idx');
    expect(definition).toMatch(/"deletedAt", "updatedAt"/);
  });

  it('supports one project checkpoint history', async () => {
    const definition = await indexDefinition('Checkpoint_projectId_createdAt_idx');
    expect(definition).toMatch(/"projectId", "createdAt"/);
  });

  it('supports per-project credit attribution', async () => {
    const definition = await indexDefinition('CreditLedger_projectId_idx');
    expect(definition).toMatch(/"projectId"/);
    // Index, not foreign key: billing history deliberately survives project deletion.
    const constraints = await prisma.$queryRaw<Array<{ conname: string }>>`
      SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class child ON child.oid = c.conrelid
      JOIN pg_attribute a ON a.attrelid = child.oid AND a.attnum = ANY (c.conkey)
      WHERE child.relname = 'CreditLedger' AND c.contype = 'f' AND a.attname = 'projectId'
    `;
    expect(constraints).toHaveLength(0);
  });

  it('reserves a single-use invite token that nothing issues yet', async () => {
    const definition = await indexDefinition('Invite_tokenHash_key');
    expect(definition).toMatch(/UNIQUE/i);
    // The columns exist; the acceptance flow does not (F-351, Wave 6). Every row must
    // still be a history row, so nothing reads a token that no route can mint.
    //
    // Settled, not sampled: invite-acceptance.test.ts runs in a parallel worker
    // against this same database and holds token-bearing rows mid-test, so a
    // single read here loses that race a few percent of the time - measured as
    // "expected 8 to be +0" failing a pre-push. A count that returns to zero is
    // the invariant holding; one that stays nonzero still fails below.
    const pendingCount = async () => {
      const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) AS count FROM "Invite" WHERE "tokenHash" IS NOT NULL
      `;
      return Number(rows[0].count);
    };
    let pending = await pendingCount();
    for (let attempt = 0; pending !== 0 && attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      pending = await pendingCount();
    }
    expect(pending).toBe(0);
  });
});

/**
 * The runtime half of F-352. The four assertions above are this suite's own
 * reading of the migrations; `DATABASE_INVARIANTS` is the list the running app
 * probes its connected database against at boot. They have to be the same four
 * objects, and the probe has to agree with Postgres — otherwise the boot check
 * is either watching the wrong thing or reporting healthy for a database this
 * suite would have failed.
 */
describe('the boot probe agrees with this suite', () => {
  it('names the same four objects', () => {
    expect(DATABASE_INVARIANTS.map((row) => row.name).sort()).toEqual([
      'Deployment_dns_label_key',
      'generation_job_project_idempotency_key',
      'one_active_job_per_project',
      'user_prevent_last_admin',
    ]);
  });

  it('finds all four present in the connected database', async () => {
    const report = await checkDatabaseInvariants(prisma);
    expect(report.broken).toEqual([]);
    expect(report.probes).toHaveLength(4);
    // Anti-vacuity: the probe reads real definitions, not just names.
    const oneActive = report.probes.find((probe) => probe.name === 'one_active_job_per_project');
    expect(oneActive?.definition).toMatch(/QUEUED/);
  });
});
